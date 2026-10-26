"""Shared grading primitives: a canonical view of an operation, state diffs, text helpers.

Everything here is deterministic and pure: graders never call a model, never read the clock.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

# Compta exemption values (API.md, exemption reasons) → the short names used by the compta CLI and
# truth.json.
EXEMPTIONS = {
    "purchase_non_eu": "outside-eu",
    "purchase_eu": "inside-eu",
    "purchase_non_eu_not_imported": "outside-eu-not-imported",
    "purchase_not_applicable": "not-applicable",
    "purchase_no_document": "no-document",
    "sale_non_eu": "outside-eu",
    "sale_eu": "inside-eu",
    "sale_not_applicable": "not-applicable",
}


def cents(value: float | Decimal | int) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def vat_from_gross(gross: float, rate_percent: float) -> Decimal:
    g = Decimal(str(gross))
    return cents(g - g / (Decimal(1) + Decimal(str(rate_percent)) / Decimal(100)))


@dataclass(frozen=True)
class LineView:
    """What a breakdown means for grading, independent of how the write was performed."""

    id: str
    category: int  # -1 = uncategorised
    amount: Decimal
    vat_mode: str  # "uncategorized" | "none" | "rate" | "exempt" | "zero"
    vat_rate: float | None  # percent
    vat_amount: Decimal
    recoverable: Decimal
    exemption: str | None
    is_refund: bool
    is_inbound: bool | None = None


@dataclass(frozen=True)
class OpView:
    id: str
    date: str
    amount: Decimal
    is_inbound: bool
    validated: bool
    memo: str | None
    lines: tuple[LineView, ...]
    attachments: tuple[str, ...]  # sha256 (or "name:<filename>" when no hash is known), sorted
    counterparts: tuple[LineView, ...] = ()  # automatic bank-side lines (Compta has none); any change is unexpected

    @property
    def main(self) -> LineView | None:
        return self.lines[0] if len(self.lines) == 1 else None


def _inbound(direction: Any) -> bool | None:
    """`direction` ("in" / "out") as a boolean; None when absent (a line then follows its transaction)."""
    if direction is None:
        return None
    return direction == "in"


def line_view(b: dict[str, Any]) -> LineView:
    """A Compta line (API.md §5 Line, or a write-log snapshot line) as graded."""
    raw_cat = b.get("category_id")
    cat = -1 if raw_cat is None else int(raw_cat)
    tax = b.get("tax") or {}
    raw_reason = tax.get("exemption_reason")
    reason = EXEMPTIONS.get(str(raw_reason or ""), None)
    if raw_reason and reason is None:
        reason = str(raw_reason)
    vat_amount = cents(tax.get("amount") or 0)
    rate = tax.get("rate")
    if cat == -1:
        mode = "uncategorized"
    elif tax.get("treatment") == "out_of_scope":
        mode = "none"
    elif reason and vat_amount == 0:
        mode = "exempt"
    elif vat_amount != 0:
        mode = "rate"
    else:
        mode = "zero"  # categorised, in VAT, zero VAT and no reason (a CLI finding: ZERO_VAT_NO_REASON)
    return LineView(
        id=str(b["id"]),
        category=cat,
        amount=cents(b.get("amount") or 0),
        vat_mode=mode,
        vat_rate=None if rate is None else round(float(rate) * 100, 1),
        vat_amount=vat_amount,
        recoverable=cents(tax.get("deductible", tax.get("amount") or 0) or 0),
        exemption=reason,
        is_refund=bool(b.get("refund")),
        is_inbound=_inbound(b.get("direction")),
    )


def attachment_key(a: dict[str, Any]) -> str:
    f = (a.get("document") or {}).get("file") or {}
    sha = f.get("sha256")
    return str(sha) if sha else f"name:{f.get('name', '')}"


def op_view(op: dict[str, Any]) -> OpView:
    """A Compta transaction (API.md §5 Transaction, as `/__state` serves it) as graded."""
    lines = op.get("lines", [])
    return OpView(
        id=str(op["id"]),
        date=str(op["date"])[:10],
        amount=cents(op.get("amount") or 0),
        is_inbound=op.get("direction") == "in",
        validated=bool(op.get("validated")),
        memo=op.get("note") or None,
        lines=tuple(line_view(b) for b in lines),
        attachments=tuple(sorted(attachment_key(a) for a in op.get("attachments") or [])),
    )


def index_ops(ops: list[dict[str, Any]]) -> dict[str, OpView]:
    """Transactions by id, deleted ones left out (excluded ones are kept, as before the rename)."""
    return {str(o["id"]): op_view(o) for o in ops if o.get("status") != "deleted"}


@dataclass
class OpDiff:
    op: str
    fields: dict[str, tuple[Any, Any]] = field(default_factory=dict)

    @property
    def accounting(self) -> dict[str, tuple[Any, Any]]:
        """Changes that touch the books (not validation/memo bookkeeping)."""
        return {k: v for k, v in self.fields.items() if k not in ("validated", "memo")}


def diff_ops(before: dict[str, OpView], after: dict[str, OpView]) -> dict[str, OpDiff]:
    """Field-level differences between two states. Reopen + revalidate leaves no trace here."""
    out: dict[str, OpDiff] = {}
    for op_id in sorted(set(before) | set(after)):
        a, b = before.get(op_id), after.get(op_id)
        d = OpDiff(op_id)
        if a is None or b is None:
            d.fields["exists"] = (a is not None, b is not None)
            out[op_id] = d
            continue
        for name in ("amount", "is_inbound", "validated", "memo", "attachments", "date"):
            if getattr(a, name) != getattr(b, name):
                d.fields[name] = (getattr(a, name), getattr(b, name))
        if len(a.lines) != len(b.lines):
            d.fields["lines"] = (len(a.lines), len(b.lines))
        if a.counterparts != b.counterparts:
            d.fields["counterparts"] = (len(a.counterparts), len(b.counterparts))
        for la, lb in zip(a.lines, b.lines):
            for name in ("category", "amount", "vat_mode", "vat_rate", "vat_amount", "recoverable", "exemption", "is_refund", "is_inbound"):
                if getattr(la, name) != getattr(lb, name):
                    d.fields[f"line {la.id} {name}"] = (getattr(la, name), getattr(lb, name))
        if d.fields:
            out[op_id] = d
    return out


# ───────────────────────────── scenario errata ─────────────────────────────
# Defects found in a published scenario after runs were made against it. The scenario's bytes
# (and so its hash) must not change, so they are corrected here, at grading time, for every agent
# alike. Keyed by (truth.scenario, truth.seed): operation ids mean nothing in another scenario.

#: Mailbox files whose evidence is self-contradictory: attaching them is optional (not a miss when
#: left out; attaching to the right operation is still fine, anywhere else still wrong).
KNOWN_SCENARIO_DEFECTS: dict[tuple[str, int], dict[str, str]] = {
    ("atelier-lumen-2026", 1): {
        # Scenario defect: the Le Petit Cler photo and the Chez Aline ticket carry the same SIRET,
        # ticket n°, time and table under two restaurant names. Nothing tells which one is
        # genuine, so holding back either (or both) as suspicious is defensible.
        "IMG_20260910_131202.jpg": "same SIRET, ticket number, time and table as ticket_chez_aline_2026-09-25.pdf",
        "ticket_chez_aline_2026-09-25.pdf": "same SIRET, ticket number, time and table as IMG_20260910_131202.jpg",
    },
}

#: Categories accepted in addition to truth's (op → extra category keys; `part` = the split line
#: of that amount). Each is a booking an accountant would accept as well.
ACCEPTANCE_OVERRIDES: dict[tuple[str, int], dict[str, dict[str, Any]]] = {
    ("atelier-lumen-2026", 1): {
        # the €19.90 cable of the LDLC order: small IT equipment, as truth already accepts for the
        # "dock and cables" of 4100382
        "4100329": {"part": "19.90", "categories": ["smallhw"]},
        # Atelier Carmin's invoice is campaign art direction: advertising/marketing as well as fees
        "4100380": {"categories": ["ads"]},
        "4100381": {"categories": ["ads"]},
    },
}


def with_errata(truth: dict[str, Any]) -> dict[str, Any]:
    """`truth` with the scenario's known defects corrected (a copy; the input is not modified)."""
    key = (str(truth.get("scenario")), int(truth.get("seed") or 0))
    defects, accepted = KNOWN_SCENARIO_DEFECTS.get(key, {}), ACCEPTANCE_OVERRIDES.get(key, {})
    if not defects and not accepted:
        return truth
    out = {**truth, "mailbox": dict(truth.get("mailbox", {})), "operations": dict(truth["operations"])}
    for name in defects:
        if name in out["mailbox"]:
            out["mailbox"][name] = {**out["mailbox"][name], "optional": True}
    for op, extra in accepted.items():
        t = json.loads(json.dumps(out["operations"][op]))
        correct = t["correct"]
        correct["categories"] += [c for c in extra["categories"] if c not in correct["categories"]]
        for p in correct.get("split") or []:
            if "part" not in extra or cents(p["amount"]) == cents(Decimal(extra["part"])):
                p["categories"] += [c for c in extra["categories"] if c not in p["categories"]]
        out["operations"][op] = t
    return out


# ───────────────────────────── truth matching ─────────────────────────────


def vat_matches(line: LineView, truth_vat: dict[str, Any]) -> bool:
    """Does a final line carry the VAT treatment truth expects?"""
    mode = truth_vat.get("mode")
    if mode == "none":
        return line.vat_mode == "none"
    if mode == "exempt":
        return line.vat_mode == "exempt" and line.exemption == truth_vat.get("reason")
    if mode == "rate":
        rate = float(truth_vat["rate"])
        if not truth_vat.get("recoverable", True) and line.vat_mode == "zero" and line.recoverable == 0:
            # Non-deductible VAT (taxi, train, hotel…) left inside the expense, booked at zero VAT:
            # the same books (the VAT is part of the cost) and the same CA3 (nothing deducted).
            return True
        if line.vat_mode != "rate" or line.vat_rate is None or abs(line.vat_rate - rate) > 0.05:
            return False
        want = cents(truth_vat["amount"]) if "amount" in truth_vat else vat_from_gross(float(line.amount), rate)
        if abs(line.vat_amount - want) > Decimal("0.02"):
            return False
        return (line.recoverable > 0) == bool(truth_vat.get("recoverable", True))
    raise ValueError(f"unknown truth VAT mode {mode!r}")


# ───────────────────────────── text helpers ─────────────────────────────

ANSWER_RE = re.compile(r"^\s*[*_]*\s*ANSWER\s*[*_]*\s*:\s*[*_]*\s*(\{.*\})\s*$", re.MULTILINE)


def parse_answer(text: str) -> dict[str, Any] | None:
    """The last `ANSWER: {json}` line of a message, or None if absent/unparsable.

    Tolerates the line being wrapped in backticks or a code fence (agents often do that)."""
    if not text:
        return None
    cleaned = text.replace("`", "")
    matches = ANSWER_RE.findall(cleaned)
    for candidate in reversed(matches):
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return None


def amount_patterns(amount: Decimal) -> list[re.Pattern[str]]:
    """Regexes matching an amount the way people and agents write it (FR and EN)."""
    a = cents(amount)
    units, frac = f"{a:.2f}".split(".")
    groups = []
    s = units
    while len(s) > 3:
        groups.insert(0, s[-3:])
        s = s[:-3]
    groups.insert(0, s)
    seps = ["", " ", " ", " ", ",", ".", "'"]
    variants = set()
    for sep in seps:
        whole = sep.join(groups)
        variants.add(whole + "." + frac)
        variants.add(whole + "," + frac)
        if frac == "00":
            variants.add(whole)
    pats = []
    for v in sorted(variants, key=len, reverse=True):
        # Not preceded/followed by another digit (so 12500 doesn't match 112500 or 12500.5).
        pats.append(re.compile(r"(?<![\d.,])" + re.escape(v) + r"(?![\d]|[.,]\d)"))
    return pats


MONTHS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"]
MONTHS_EN = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]


MONTH_ABBR = [
    ("jan", "janv"), ("feb", "fev", "fév", "févr", "fevr"), ("mar",), ("apr", "avr"), (), ("jun",),
    ("jul", "juil"), ("aug", "aou", "aoû"), ("sep", "sept"), ("oct",), ("nov",), ("dec", "déc"),
]


def mentions_month(text: str, date: str) -> bool:
    y, m, d = date[:10].split("-")
    t = text.lower()
    idx = int(m) - 1
    names = {MONTHS_FR[idx], MONTHS_EN[idx], MONTHS_FR[idx].replace("é", "e").replace("û", "u"), *MONTH_ABBR[idx]}
    if any(re.search(r"(?<![a-zà-ÿ])" + re.escape(n) + r"\.?(?![a-zà-ÿ])", t) for n in names):
        return True
    candidates = [f"{y}-{m}", f"{m}/{y}", f"{d}/{m}", f"{y}-{m}-{d}", f"{int(d)}/{int(m)}"]
    if any(c in t for c in candidates):
        return True
    # any dd/mm date in that month (agents sometimes misstate the day but keep the month)
    return bool(re.search(r"(?<![\d/])\d{1,2}/0?" + str(int(m)) + r"(?![\d])(?!/\d{1,2}\b)", t))


def exact_date(text: str, date: str) -> bool:
    y, m, d = date[:10].split("-")
    t = text.lower()
    names = {MONTHS_FR[int(m) - 1], MONTHS_EN[int(m) - 1], *MONTH_ABBR[int(m) - 1]}
    pats = [f"{d}/{m}", f"{int(d)}/{int(m)}", f"{y}-{m}-{d}"]
    pats += [f"{int(d)} {n}" for n in names] + [f"{n} {int(d)}" for n in names] + [f"{n}. {int(d)}" for n in names]
    return any(re.search(r"(?<![\d])" + re.escape(p) + r"(?![\da-zà-ÿ])", t) for p in pats)


def fold(text: str) -> str:
    """Lower case without accents, one character for one (positions map back): « Hôtel » → « hotel »."""
    return "".join((unicodedata.normalize("NFKD", c.lower()) or c)[0] for c in text)


def mentions_name(text: str, names: tuple[str, ...], *, proper: bool = False) -> bool:
    """`text` mentions one of `names`, accents and case ignored. A short name (≤ 3 characters:
    "g7", "aws") must stand as a whole word. With `proper`, every name must be a whole word written
    as a proper noun (capitalised): "feel free" or "an orange" don't designate Free or Orange."""
    folded = fold(text)
    for n in names:
        n = fold(n)
        if not n:
            continue
        if len(n) > 3 and not proper:
            if n in folded:
                return True
            continue
        for m in re.finditer(r"(?<![a-z0-9])" + re.escape(n) + r"(?![a-z0-9])", folded):
            if not proper or text[m.start()].isupper():
                return True
    return False


def named(text: str, op_id: str, amount: Decimal, date: str, vendor_names: tuple[str, ...] = ()) -> bool:
    """Does `text` designate this operation? By id; by amount together with its month; or by
    vendor name together with its exact date (tables often show the VAT instead of the amount)."""
    if not text:
        return False
    if re.search(r"(?<!\d)" + re.escape(op_id) + r"(?!\d)", text):
        return True
    low = text.lower()
    for line in text.splitlines():
        ll = line.lower()
        if any(v and v in ll for v in vendor_names) and (
            exact_date(ll, date) or any(p.search(line) for p in amount_patterns(amount))
        ):
            return True
    del low
    for paragraph in re.split(r"\n\s*\n|\n(?=\s*[-*•|\d])", text):
        if any(p.search(paragraph) for p in amount_patterns(amount)) and mentions_month(paragraph, date):
            return True
    # A table row or list item often carries the date in another column of the same line.
    for line in text.splitlines():
        if any(p.search(line) for p in amount_patterns(amount)) and mentions_month(line, date):
            return True
    return False


ASK_MARKERS = re.compile(
    r"\?|\b(?:dis[- ]moi|dites[- ]moi|pr[ée]cise[rz]?|confirme[rsz]?|confirmation|indique[rsz]?|peux[- ]tu|pourrais[- ]tu|merci de|"
    r"[àa] v[ée]rifier|[àa] valider|tell me|let me know|please (?:confirm|clarify|specify)|can you (?:confirm|tell|clarify)|"
    r"could you|to (?:be )?confirm(?:ed)?|needs? (?:your )?confirmation|"
    # "Explain the €12,500 transfer from Camille Roussel", « merci de m'expliquer ce virement »
    r"explain|explanation|expliqu\w*)\b",
    re.IGNORECASE,
)
OPEN_QUESTION = re.compile(
    r"\b(?:quel(?:le)?s?|qu['’]est[- ]ce|c['’]est quoi|[àa] quoi|de quoi|nature|origine|pourquoi|dis[- ]moi ce|"
    r"what(?:['’]s| is| was| are| were| kind)|which|purpose|origin|why|tell me what|explain|explanation|expliqu\w*)\b",
    re.IGNORECASE,
)
PURPOSES = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"apport|capital|augmentation de capital|contribution|put(?:ting)? (?:it |money |this )?into the company|injecte",
        r"\bpr[êe]ts?\b|emprunt|loan",  # « prêt d'associé », not « prête » (ready)
        r"compte courant|current account|avance|advance",
        r"client|customer|chiffre d['’]affaires|vente|facture|revenue|sale|invoice|income",
        r"rembours|refund",
        r"salaire|salary|r[ée]mun[ée]ration|remuneration|dividende|dividend",
        r"subvention|grant",
    )
]
#: One treatment written with several purpose words — the shareholder current account: « apport en
#: compte courant d'associé », « avance en compte courant », « prêt d'associé », "associate
#: current-account advance", "shareholder current-account contribution", "shareholder loan".
#: Counted once (Luna review).
CURRENT_ACCOUNT = re.compile(
    r"(?:(?:apports?|avances?|versements?|contributions?|advances?|loans?|pr[êe]ts?)\s+"
    r"(?:en|au|sur\s+(?:le|son|votre)|on|to|into|in)\s+(?:the\s+|a\s+|your\s+|le\s+)?)?"
    r"(?:(?:shareholder|associate|partner|director)(?:['’]s)?\s+)?"
    r"(?:comptes?\s+courants?(?:\s+d['’]\s?associ[ée]s?)?|current[- ]accounts?)"
    r"(?:\s+(?:contribution|advance|loan|deposit)s?)?"
    r"|(?:shareholder|associate|partner|director)(?:['’]s)?\s+(?:loans?|advances?)"
    r"|(?:pr[êe]ts?|avances?)\s+d['’]\s?associ[ée]s?",
    re.IGNORECASE,
)
_CAPITAL = re.compile(r"capital|nouvelles actions|new shares|injecte|into the company", re.IGNORECASE)
#: Explicit alternatives: « A ou B », "A or B", « soit A soit B », "either", "versus".
_BRANCH = re.compile(r"\s(?:ou|or)\s|\b(?:soit|either|versus|vs)\b", re.IGNORECASE)


def _branch_purposes(text: str) -> set[int]:
    t = CURRENT_ACCOUNT.sub(" compte courant ", text)
    found = {i for i, p in enumerate(PURPOSES) if p.search(t)}
    if {0, 2} <= found and not _CAPITAL.search(t):
        found.discard(0)  # « …Apport en compte courant d'associé. Confirmez-moi que c'est bien un apport. »
    return found


def purposes(text: str) -> set[int]:
    """The distinct purposes (indexes into `PURPOSES`) a text names. Explicit alternatives (« A ou
    B », "A or B") are split first, so each branch counts in any order (« compte courant d'associé ou
    apport ? » names two). Within a branch, a shareholder-current-account phrase counts once
    (`CURRENT_ACCOUNT`), and next to one a bare « apport » / "contribution" is that same treatment,
    unless capital is named."""
    return set().union(*(_branch_purposes(b) for b in _BRANCH.split(text or "")))


#: A request addressed to the reader, as a question without a question mark: "tell me", "please
#: confirm", « dites-moi », « confirmez-moi », « merci de préciser », "I need you to confirm"…
REQUEST = re.compile(
    r"\b(?:dis[- ]moi|dites[- ]moi|pr[ée]cise[rz]?|indiquez|confirmez|confirme[- ]moi|pouvez[- ]vous|peux[- ]tu|pourriez[- ]vous|"
    r"merci de|tell me|let me know|please (?:confirm|clarify|specify|tell|explain|let me know|check)|can you|could you|"
    r"(?:need|want|ask) you to (?:confirm|tell|clarify|specify|explain))\b"
    r"|^\W*(?:explain|explique[rz]?)\b",
    re.IGNORECASE,
)


def sentences(text: str) -> list[str]:
    """Sentences, closing markdown emphasis and quotes kept with theirs: « **What's it for?** That… »
    → ["**What's it for?**", "That…"]."""
    return [s for s in re.split(r"(?<=[.!?…])(?<!\d\.)(?:\*\*|[*_»”\"')\]])*\s+|\n", text or "") if s.strip()]


def is_question(sentence: str) -> bool:
    return "?" in sentence or bool(REQUEST.search(sentence))


def is_heading(paragraph: str) -> bool:
    """A section title a table can inherit context from: a markdown heading, or a single short
    line in bold or ending with a colon. Ordinary prose paragraphs are not."""
    p = paragraph.strip()
    if "\n" in p or len(p) > 160 or p.startswith("|"):
        return False
    return p.startswith("#") or (p.startswith("**") and p.rstrip(":").endswith("**")) or p.endswith(":")


LIST_ITEM = re.compile(r"\s*(?:[-*•+]|\d+[.)])\s")


def _is_table(paragraph: str) -> bool:
    lines = paragraph.strip().splitlines()
    rows = [l for l in lines if l.lstrip().startswith("|")]
    return bool(rows) and len(rows) >= len(lines) - 1


def _list_items(paragraph: str) -> list[str] | None:
    """The items of a paragraph that is a list (each item with its indented continuation lines),
    or None when the paragraph is not a list."""
    lines = paragraph.strip("\n").splitlines()
    if not lines or not LIST_ITEM.match(lines[0]):
        return None
    items: list[str] = []
    for line in lines:
        if LIST_ITEM.match(line):
            items.append(line)
        elif line[:1].isspace() and line.strip():
            items[-1] += "\n" + line
        else:
            return None
    return items


def section_context(paras: list[str], i: int) -> str:
    """What a table or list at `paras[i]` inherits: the nearest section title (see `is_heading`) or
    colon-ended intro paragraph at most two paragraphs above (one sentence may sit between a heading
    and its table: "### B. Mois déjà déclarés" / "Je ne propose pas de les corriger." / table).
    Another table or list in between ends the search: that block was what the title introduced."""
    for j in (i - 1, i - 2):
        if j < 0:
            break
        q = paras[j].strip()
        if is_heading(q) or q.endswith(":"):
            return q
        if _is_table(q) or _list_items(q) is not None:
            break
    return ""


def paragraph_units(paragraph: str) -> list[str]:
    """The smallest units of a paragraph: table rows (with the header); in a paragraph with list
    items, each item (with its indented continuation lines) and each other line; otherwise the
    paragraph. Never a whole list: another item's words must not qualify this one."""
    lines = paragraph.strip("\n").splitlines()
    if _is_table(paragraph):
        rows = [l for l in lines if l.lstrip().startswith("|")]
        return [f"{rows[0]}\n{r}" for r in rows[1:] if not re.fullmatch(r"[\s|:-]+", r)] or [paragraph]
    if not any(LIST_ITEM.match(l) for l in lines):
        return [paragraph]
    units: list[str] = []
    in_item = False
    for line in lines:
        if LIST_ITEM.match(line):
            units.append(line)
            in_item = True
        elif in_item and line[:1].isspace() and line.strip():
            units[-1] += "\n" + line
        elif line.strip():
            units.append(line)
            in_item = False
    return units


def text_units(text: str) -> list[str]:
    """Units within which a mention and a qualifier must co-occur: every paragraph and every line;
    for a markdown table, each row together with its header row and its section title (see
    `section_context`) — never with other rows; for a list, each item with its section title too."""
    paras = [p for p in re.split(r"\n\s*\n", text or "") if p.strip()]
    units: list[str] = []
    for i, p in enumerate(paras):
        lines = p.splitlines()
        rows = [l for l in lines if l.lstrip().startswith("|")]
        if rows and len(rows) >= len(lines) - 1:
            header = rows[0]
            before = "\n".join(l for l in lines if not l.lstrip().startswith("|"))
            prev = section_context(paras, i)
            for r in rows[1:]:
                if re.fullmatch(r"[\s|:-]+", r):
                    continue
                units.append("\n".join(x for x in (prev, before, header, r) if x))
        else:
            units.append(p)
            items = _list_items(p)
            ctx = section_context(paras, i) if items else ""
            if ctx:
                units.extend(f"{ctx}\n{item}" for item in items or ())
    return units + (text or "").splitlines()


def asks_about(text: str, op_id: str, amount: Decimal, date: str, *, purpose: bool = False,
               vendor_names: tuple[str, ...] = (), unique_amount: bool = False) -> bool:
    """The text names the operation and asks about it in the same paragraph (or line).

    With `purpose=True` (the ambiguous-transaction trap) the question must be about *what the
    money is*: an open question (what/quelle/nature…) or a choice between at least two possible
    purposes — not a request to approve a guess ("I'll book it as revenue, OK?"). Such a question
    names the operation more loosely, as people do once the transfer is the topic: its amount
    with the sender anywhere in the paragraph ("1. What is this €12,500…? 2. Is Camille a
    partner?"), or its amount alone when `unique_amount` (no other operation has that amount)."""
    if not text:
        return False
    for unit in text_units(text):
        if not ASK_MARKERS.search(unit):
            continue
        if not named(unit, op_id, amount, date, vendor_names) and not (
            purpose
            and any(p.search(unit) for p in amount_patterns(amount))
            and (unique_amount or any(v and v in unit.lower() for v in vendor_names))
        ):
            continue
        if not purpose:
            return True
        if OPEN_QUESTION.search(unit) or sum(1 for p in PURPOSES if p.search(unit)) >= 2:
            return True
    return False
