"""Usage/rate-limit classification helpers. Only ever applied to structured error events emitted
by the agent CLIs (Claude `rate_limit_event` / `result` errors, Codex `error` / `turn.failed`),
never to the agent's own prose."""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

PARIS = ZoneInfo("Europe/Paris")

LIMIT_RE = re.compile(
    r"usage limit|rate limit|rate_limit|usage_limit|hit your (?:usage )?limit|limit reached|"
    r"too many requests|\b429\b|quota",
    re.IGNORECASE,
)
AUTH_RE = re.compile(r"\b401\b|unauthori[sz]ed|invalid api key|/login|not logged in|token (?:has )?expired|\b403\b", re.IGNORECASE)

_MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], start=1)}  # fmt: skip


def is_limit_message(text: str) -> bool:
    return bool(LIMIT_RE.search(text or ""))


def is_auth_message(text: str) -> bool:
    return bool(AUTH_RE.search(text or ""))


def _clock(h: int, m: int, ampm: str | None) -> tuple[int, int]:
    if ampm:
        ampm = ampm.lower()
        if ampm.startswith("p") and h != 12:
            h += 12
        if ampm.startswith("a") and h == 12:
            h = 0
    return h, m


def parse_reset(text: str, now: datetime | None = None) -> datetime | None:
    """Best-effort reset time from a limit message; None when no time is given."""
    if not text:
        return None
    now = now or datetime.now(PARIS)
    if now.tzinfo is None:
        now = now.replace(tzinfo=PARIS)
    # "Claude AI usage limit reached|1760000000", "resets_at": 1760000000, "resetsAt": …
    m = re.search(r"(?:\||resets_?at\"?\s*[:=]\s*\"?)(\d{10})\b", text, re.IGNORECASE)
    if m:
        return datetime.fromtimestamp(int(m.group(1)), tz=PARIS)
    m = re.search(r"resets?_in_seconds\"?\s*[:=]\s*(\d+)", text, re.IGNORECASE)
    if m:
        return now + timedelta(seconds=int(m.group(1)))
    # "try again in 2 days 3 hours 4 minutes", "resets in 45 min"
    m = re.search(
        r"(?:try again|resets?)\s+in\s+(?:(\d+)\s*days?)?[\s,]*(?:(\d+)\s*h(?:ours?|rs?)?)?[\s,]*"
        r"(?:(\d+)\s*m(?:in(?:ute)?s?)?)?[\s,]*(?:(\d+)\s*s(?:ec(?:ond)?s?)?)?",
        text,
        re.IGNORECASE,
    )
    if m and any(m.groups()):
        d, h, mi, s = (int(x) if x else 0 for x in m.groups())
        return now + timedelta(days=d, hours=h, minutes=mi, seconds=s)
    # "try again at Oct 20th, 2026 5:34 PM"
    m = re.search(
        r"(?:at|resets?)\s+([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}),?\s+"
        r"(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?",
        text,
        re.IGNORECASE,
    )
    if m and m.group(1)[:3].lower() in _MONTHS:
        h, mi = _clock(int(m.group(4)), int(m.group(5) or 0), m.group(6))
        return datetime(int(m.group(3)), _MONTHS[m.group(1)[:3].lower()], int(m.group(2)), h, mi, tzinfo=now.tzinfo)
    # "try again at 5:34 PM", "resets 5pm (Europe/Paris)", "resets at 17:00"
    m = re.search(
        r"(?:try again at|resets?(?: at)?)\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?:\s*\(([\w/+-]+)\))?",
        text,
        re.IGNORECASE,
    )
    if m and (m.group(2) or m.group(3)):
        tz = now.tzinfo
        if m.group(4):
            try:
                tz = ZoneInfo(m.group(4))
            except Exception:  # noqa: BLE001 - unknown zone name: keep local time
                pass
        h, mi = _clock(int(m.group(1)), int(m.group(2) or 0), m.group(3))
        local_now = now.astimezone(tz)
        at = local_now.replace(hour=h, minute=mi, second=0, microsecond=0)
        if at <= local_now:
            at += timedelta(days=1)
        return at
    return None
