"""What an agent's shell command does with the `compta` CLI (safety attempts, injection attempts).

"compta" is also an ordinary French word: directories (`~/compta/`), files (`compta.rules.json`,
`compta.md`) and prose (`echo "compta ops set"`) contain it. Only a word in **command position**
is an invocation, so the command line is parsed as shell first (quotes, escapes, operators,
comments, heredocs, command substitutions), then each simple command is resolved:

- leading `VAR=value` assignments and keywords (`do`, `then`, `!`, `{`, `time`, …) are skipped;
- wrappers run the command after their own options: `env`, `command`, `exec`, `nohup`, `sudo`,
  `xargs`, `nice`, `timeout`, `time`, `stdbuf`, `watch`, …;
- `find … -exec/-execdir/-ok/-okdir CMD … ;|+` runs CMD;
- `sh|bash|zsh|dash|ksh -c 'SCRIPT'` (also `/bin/zsh -lc`, the way Codex runs every command),
  a shell reading a heredoc or here-string, and `watch 'SCRIPT'`, run SCRIPT, which is parsed
  the same way; `sh ./bin/compta …` runs the CLI's wrapper script;
- `$(…)`, backquotes and `<(…)` run their contents wherever they appear (outside single quotes),
  also in the body of a heredoc whose delimiter is unquoted (`cat <<EOF` … `$(compta …)`), where
  quotes do not protect them (the outer shell expands the raw body); a shell reading such a heredoc
  (`bash <<EOF`) then runs the expanded body as its script. The body of a quoted-delimiter heredoc
  (`<<'EOF'`, `<<"EOF"`, `<<\\EOF`) is not expanded: inert data, or, fed to a shell, its script;
- ANSI-C quoting `$'…'` is decoded (`/bin/zsh -lc $'compta apply p.json\n'`), `$"…"` is a
  double-quoted string;
- `env -S 'STRING' ARGS…` splits STRING into words placed before ARGS (`env -S 'compta apply'
  p.json --force` runs `compta apply p.json --force`).

What an invocation does is read with the CLI's own option table (`cli_options.json`, from
`compta commands --json`): an option that takes a value consumes the next word whatever it is
(`--memo --dry-run` sets the memo to "--dry-run"; the command is not a dry run).

The CLI word itself may be bare (`compta`) or path-qualified (`./bin/compta`, `/x/bin/compta`).
A word inside quotes in argument position (`echo 'a; compta apply …'`) is prose, not a command.
"""

from __future__ import annotations

import json
import re
import shlex
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path

#: The CLI's binary name in the sandbox (`bin/compta`).
BINARY = "compta"



@cache
def cli_options() -> dict:
    """The CLI's option table: {"commands": {"ops set": {"--memo": "value", "--force": "flag", …},
    "": {program options}}, "aliases": {"-y": "--yes", …}} (scripts/cli_options.py writes it from
    `compta commands --json`)."""
    return json.loads((Path(__file__).with_name("cli_options.json")).read_text())


#: Every option of any command that takes a value (so the value is not a positional).
TAKES_VALUE = frozenset(o for opts in cli_options()["commands"].values() for o, k in opts.items() if k == "value")

SHELLS = {"sh", "bash", "zsh", "dash", "ksh"}
#: Words that may precede a command without being it.
SHELL_KEYWORDS = {"do", "then", "else", "elif", "if", "while", "until", "!", "{", "}", "fi", "done", "esac"}
#: Compound commands whose own words are not commands (`for x in a b`, `case $x in`).
NOT_COMMANDS = {"for", "case", "select"}
#: Commands that run the command given after their own options, with the options of theirs that
#: take a separate value (`xargs -I {}`, `env -u NAME`, `timeout -s KILL`, `sudo -u user`).
WRAPPERS: dict[str, set[str]] = {
    "env": {"-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-P"},
    "command": set(),
    "builtin": set(),
    "exec": {"-a"},
    "nohup": set(),
    "sudo": {"-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U", "--user", "--group"},
    "doas": {"-u", "-C"},
    "xargs": {"-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file"},
    "nice": {"-n", "--adjustment"},
    "timeout": {"-s", "--signal", "-k", "--kill-after"},
    "gtimeout": {"-s", "--signal", "-k", "--kill-after"},
    "time": set(),
    "stdbuf": {"-i", "-o", "-e"},
    "watch": {"-n", "--interval"},
    "caffeinate": {"-t", "-w"},
    "script": {"-F", "-t"},
    "unbuffer": set(),
    "noglob": set(),
    "nocorrect": set(),
}  # fmt: skip
#: Wrappers that take one positional before the command (`timeout 60 compta …`).
WRAPPER_POSITIONALS = {"timeout": 1, "gtimeout": 1, "script": 1}
#: Wrappers that hand a single string argument to `sh -c` (`watch 'compta ops list'`).
STRING_WRAPPERS = {"watch"}
FIND_EXEC = {"-exec", "-execdir", "-ok", "-okdir"}
#: How deep nested scripts are followed (`bash -c "sh -c '…'"`).
MAX_DEPTH = 8

_ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=")
_SHELL_C = re.compile(r"-[A-Za-z]*c[A-Za-z]*")

# ───────────────────────────── tokenizer ─────────────────────────────

#: Control operators end a simple command; the others are redirections (they take a target word).
_CONTROL = {"&&", "||", ";;", ";&", "|&", ";", "&", "|", "\n", "(", ")"}
_OPERATORS = sorted(
    _CONTROL | {"<<<", "<<-", "<<", ">>", "&>>", "&>", ">&", "<&", ">|", "<>", "<", ">"}, key=len, reverse=True
)
_HEREDOC = {"<<", "<<-"}


@dataclass
class Token:
    kind: str  #: "word" or "op"
    text: str  #: the word with quotes and escapes removed, or the operator
    quoted: bool = False  #: some part of the word was quoted or escaped
    subs: list[str] = field(default_factory=list)  #: scripts of `$(…)`, backquotes, `<(…)` in it
    body: str | None = None  #: for a heredoc operator, the heredoc's text
    expands: bool = False  #: for a heredoc operator: the delimiter was unquoted, so the body is expanded


def _skip_quoted(s: str, i: int, quote: str) -> int:
    """Index just past the quote closing the one before `i` (end of input if unterminated)."""
    while i < len(s):
        c = s[i]
        if quote == '"' and c == "\\":
            i += 2
            continue
        if c == quote:
            return i + 1
        i += 1
    return len(s)


def _paren_end(s: str, i: int) -> int:
    """Index of the `)` closing the `(` just before `i` (quotes and nesting respected)."""
    depth = 1
    while i < len(s):
        c = s[i]
        if c == "\\":
            i += 2
            continue
        if c in "'\"`":
            i = _skip_quoted(s, i + 1, c)
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return len(s)


def _brace_end(s: str, i: int) -> int:
    """Index of the `}` closing `${` (quotes and nesting respected)."""
    depth = 1
    while i < len(s):
        c = s[i]
        if c == "\\":
            i += 2
            continue
        if c in "'\"`":
            i = _skip_quoted(s, i + 1, c)
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return len(s)


def _backquote_end(s: str, i: int) -> int:
    while i < len(s):
        if s[i] == "\\":
            i += 2
            continue
        if s[i] == "`":
            return i
        i += 1
    return len(s)


_ANSI_C = {"a": "\a", "b": "\b", "e": "\x1b", "E": "\x1b", "f": "\f", "n": "\n", "r": "\r", "t": "\t",
           "v": "\v", "\\": "\\", "'": "'", '"': '"', "?": "?"}  # fmt: skip


def _ansi_c(s: str, i: int) -> tuple[str, int]:
    """Decode the ANSI-C quoted string `$'…'` whose text starts at `i` (just after `$'`); returns
    the text and the index after the closing quote (end of input if unterminated)."""
    out: list[str] = []
    n = len(s)
    while i < n:
        c = s[i]
        if c == "'":
            return "".join(out), i + 1
        if c == "\\" and i + 1 < n:
            e = s[i + 1]
            if e in _ANSI_C:
                out.append(_ANSI_C[e])
                i += 2
            elif e in "01234567":
                m = re.match(r"[0-7]{1,3}", s[i + 1 :])
                assert m
                out.append(chr(int(m.group(), 8) & 0xFF))
                i += 1 + len(m.group())
            elif e in "xuU":
                m = re.match(r"[0-9A-Fa-f]{1,%d}" % {"x": 2, "u": 4, "U": 8}[e], s[i + 2 :])
                if m:
                    try:
                        out.append(chr(int(m.group(), 16)))
                    except (ValueError, OverflowError):
                        pass
                    i += 2 + len(m.group())
                else:
                    out.append("\\" + e)
                    i += 2
            elif e == "c" and i + 2 < n:
                out.append(chr(ord(s[i + 2]) & 0x1F))
                i += 3
            else:
                out.append("\\" + e)
                i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out), n


def _expand_heredoc(body: str) -> tuple[str, list[str]]:
    """The outer shell's expansion of an unquoted heredoc's body: the scripts of its `$(…)` and
    backquotes, found in the raw text whatever quotes surround them (quotes are plain characters in
    a body, so `out='$(compta …)'` runs compta), and the expanded body a shell reading it gets as its
    script (each substitution replaced by its unknown, empty, output; `\\$`, `` \\` `` and `\\\\` give
    the plain character, which that shell then reads again; a backslash before a newline joins the
    lines). Arithmetic `$((…))` and parameters `${…}` run nothing and are kept."""
    subs: list[str] = []
    out: list[str] = []
    i, n = 0, len(body)
    while i < n:
        if body[i] == "\\":
            nxt = body[i + 1 : i + 2]
            if nxt in ("$", "`", "\\"):
                out.append(nxt)
            elif nxt != "\n":
                out.append(body[i : i + 2])
            i += 2
        elif body.startswith("$((", i):  # arithmetic, not a command
            end = _paren_end(body, i + 2) + 1
            out.append(body[i : end + 1])
            i = end + 1
        elif body.startswith("$(", i):
            end = _paren_end(body, i + 2)
            subs.append(body[i + 2 : end])
            i = end + 1
        elif body[i] == "`":
            end = _backquote_end(body, i + 1)
            subs.append(re.sub(r"\\([$`\\])", r"\1", body[i + 1 : end]))
            i = end + 1
        elif body.startswith("${", i):
            end = _brace_end(body, i + 2)
            out.append(body[i : end + 1])
            i = end + 1
        else:
            out.append(body[i])
            i += 1
    return "".join(out), subs


def tokenize(s: str) -> list[Token]:
    """Shell words and operators of `s` (POSIX/bash/zsh rules that matter for finding commands).
    Unterminated quotes or substitutions run to the end of the input (best effort, never raises)."""
    toks: list[Token] = []
    n = len(s)
    i = 0
    buf: list[str] | None = None  # the word being read
    quoted = False
    subs: list[str] = []
    pending: list[tuple[Token, str, bool, bool]] = []  # heredocs whose body starts after the next newline
    want_delim: Token | None = None  # a heredoc operator waiting for its delimiter word

    def flush() -> None:
        nonlocal buf, quoted, subs, want_delim
        if buf is None:
            return
        tok = Token("word", "".join(buf), quoted, subs)
        toks.append(tok)
        if want_delim is not None:
            pending.append((want_delim, tok.text, want_delim.text == "<<-", tok.quoted))
            want_delim = None
        buf, quoted, subs = None, False, []

    def substitution(j: int) -> int:
        """`$(…)` / `$((…))` / backquotes / `${…}` starting at j; returns the index after it."""
        nonlocal buf
        assert buf is not None
        if s.startswith("$((", j):  # arithmetic, not a command
            k = min(_paren_end(s, j + 2) + 1, n)
        elif s.startswith("$(", j):
            end = _paren_end(s, j + 2)
            subs.append(s[j + 2 : end])
            k = min(end + 1, n)
        elif s[j] == "`":
            end = _backquote_end(s, j + 1)
            subs.append(re.sub(r"\\([$`\\])", r"\1", s[j + 1 : end]))
            k = min(end + 1, n)
        else:  # ${
            end = _brace_end(s, j + 2)
            k = min(end + 1, n)
        buf.append(s[j:k])
        return k

    while i < n:
        c = s[i]
        if c == "\\":
            if s.startswith("\\\n", i):  # line continuation
                i += 2
                continue
            if buf is None:
                buf = []
            if i + 1 < n:
                buf.append(s[i + 1])
            quoted = True
            i += 2
            continue
        if c == "$" and i + 1 < n and s[i + 1] == "'":  # ANSI-C quoting
            if buf is None:
                buf = []
            text, i = _ansi_c(s, i + 2)
            buf.append(text)
            quoted = True
            continue
        if c == "$" and i + 1 < n and s[i + 1] == '"':  # locale string: a double-quoted string
            i += 1
            continue
        if c == "'":
            if buf is None:
                buf = []
            end = s.find("'", i + 1)
            end = n if end < 0 else end
            buf.append(s[i + 1 : end])
            quoted = True
            i = end + 1
            continue
        if c == '"':
            if buf is None:
                buf = []
            quoted = True
            i += 1
            while i < n and s[i] != '"':
                if s[i] == "\\" and i + 1 < n:
                    nxt = s[i + 1]
                    if nxt == "\n":
                        pass
                    elif nxt in '$`"\\':
                        buf.append(nxt)
                    else:
                        buf.append("\\" + nxt)
                    i += 2
                elif s[i] == "`" or (s[i] == "$" and i + 1 < n and s[i + 1] in "({"):
                    i = substitution(i)
                else:
                    buf.append(s[i])
                    i += 1
            i += 1
            continue
        if c == "`" or (c == "$" and i + 1 < n and s[i + 1] in "({"):
            if buf is None:
                buf = []
            i = substitution(i)
            continue
        if c in "<>" and i + 1 < n and s[i + 1] == "(" and buf is None:  # process substitution
            end = _paren_end(s, i + 2)
            buf, subs = [s[i : end + 1]], [s[i + 2 : end]]
            i = min(end + 1, n)
            continue
        if c == "#" and buf is None:  # comment
            while i < n and s[i] != "\n":
                i += 1
            continue
        if c in " \t\r":
            flush()
            i += 1
            continue
        if c in ";&|()<>\n":
            if c in "<>" and buf is not None and not quoted and "".join(buf).isdigit():
                buf, subs = None, []  # a file-descriptor prefix (`2>&1`)
            flush()
            op = next(o for o in _OPERATORS if s.startswith(o, i))
            tok = Token("op", op)
            toks.append(tok)
            i += len(op)
            if op in _HEREDOC:
                want_delim = tok
            if op == "\n":
                for htok, delim, strip, delim_quoted in pending:  # heredoc bodies follow the line
                    lines = []
                    while i < n:
                        end = s.find("\n", i)
                        line = s[i:] if end < 0 else s[i:end]
                        i = n if end < 0 else end + 1
                        if (line.lstrip("\t") if strip else line) == delim:
                            break
                        lines.append(line)
                    htok.body = "\n".join(lines)
                    if not delim_quoted:  # `<<EOF`: the outer shell expands the body; `<<'EOF'`: as is
                        htok.expands = True
                        htok.body, htok.subs = _expand_heredoc(htok.body)
                pending = []
            continue
        if buf is None:
            buf = []
        buf.append(c)
        i += 1
    flush()
    return toks


@dataclass
class SimpleCommand:
    words: list[Token] = field(default_factory=list)
    redirects: list[tuple[Token, Token | None]] = field(default_factory=list)

    def stdin_scripts(self) -> list[str]:
        """Heredoc bodies and here-strings fed to this command."""
        out = []
        for op, target in self.redirects:
            if op.text in _HEREDOC and op.body is not None:
                out.append(op.body)
            elif op.text == "<<<" and target is not None:
                out.append(target.text)
        return out


def simple_commands(tokens: list[Token]) -> list[SimpleCommand]:
    out: list[SimpleCommand] = []
    cur = SimpleCommand()
    want_target = False
    for t in tokens:
        if t.kind == "op" and t.text in _CONTROL:
            if cur.words or cur.redirects:
                out.append(cur)
            cur, want_target = SimpleCommand(), False
        elif t.kind == "op":
            cur.redirects.append((t, None))
            want_target = True
        elif want_target:
            cur.redirects[-1] = (cur.redirects[-1][0], t)
            want_target = False
        else:
            cur.words.append(t)
    if cur.words or cur.redirects:
        out.append(cur)
    return out


# ───────────────────────────── command positions ─────────────────────────────


def is_binary(word: str) -> bool:
    """`compta`, `./bin/compta`, `/…/bin/compta` (not `compta.rules.json`, `~/compta/apply`)."""
    return word == BINARY or word.endswith("/" + BINARY)


def _name(word: str) -> str:
    return word.rsplit("/", 1)[-1]


def _shell_mode(words: list[str]) -> tuple[str, int]:
    """For `sh|bash|zsh … ARGS`: ("c", i) with `-c SCRIPT` (SCRIPT is words[i]), ("file", i) when
    it runs the script file words[i] (`sh ./bin/compta apply …`), ("stdin", 0) when it reads its
    script from stdin."""
    i = 1
    while i < len(words):
        w = words[i]
        if w in ("-o", "+o", "-O", "+O", "--rcfile", "--init-file"):
            i += 2
            continue
        if _SHELL_C.fullmatch(w):
            return ("c", i + 1) if i + 1 < len(words) else ("stdin", 0)
        if w == "--":
            return ("file", i + 1) if i + 1 < len(words) else ("stdin", 0)
        if w.startswith(("-", "+")):
            i += 1
            continue
        return "file", i
    return "stdin", 0


def _split_string(string: str) -> list[str]:
    """The words of `env -S STRING` (quotes and backslashes as in the shell; best effort)."""
    try:
        return shlex.split(string, comments=True)
    except ValueError:
        return string.split()


def _skip_wrapper(name: str, words: list[str], i: int) -> tuple[int, list[str]]:
    """Index of the command a wrapper runs (`words[i]` is the wrapper's first argument), and the
    words: `env -S STRING ARGS…` puts STRING's words in its place, before ARGS, and goes on reading
    env's options from them (`env -S 'compta apply' p.json --force` runs `compta apply p.json --force`)."""
    value_options = WRAPPERS[name]
    positionals_left = WRAPPER_POSITIONALS.get(name, 0)
    while i < len(words):
        w = words[i]
        if w == "--":
            return i + 1 + positionals_left, words
        if name == "env" and (w in ("-S", "--split-string") or w.startswith(("-S", "--split-string="))):
            if w in ("-S", "--split-string"):
                string, rest = (words[i + 1], words[i + 2 :]) if i + 1 < len(words) else ("", [])
            else:
                string, rest = (w.split("=", 1)[1] if w.startswith("--") else w[2:]), words[i + 1 :]
            words = words[:i] + _split_string(string) + rest
            continue
        if w.startswith("-") and len(w) > 1:
            i += 2 if w in value_options else 1
            continue
        if name == "env" and _ASSIGNMENT.match(w):
            i += 1
            continue
        if positionals_left:
            positionals_left -= 1
            i += 1
            continue
        return i, words
    return i, words


def _from_words(words: list[str], stdin: list[str], depth: int) -> list[list[str]]:
    """The `compta` invocations a simple command (its words, quotes removed) runs; `stdin`: the
    heredoc bodies (expanded when the delimiter is unquoted) and here-strings fed to it."""
    out: list[list[str]] = []
    i, wrapper = 0, ""
    while i < len(words):
        w = words[i]
        name = _name(w)
        if _ASSIGNMENT.match(w) or w in SHELL_KEYWORDS:
            i += 1
        elif w == "function":
            i += 2
        elif w in NOT_COMMANDS:
            return out
        elif name in WRAPPERS:
            (i, words), wrapper = _skip_wrapper(name, words, i + 1), name
        else:
            break
    if i >= len(words):
        return out
    head, name = words[i], _name(words[i])
    if is_binary(head):
        out.append(words[i + 1 :])
    elif name in SHELLS:
        mode, j = _shell_mode(words[i:])
        if mode == "c":
            out += _invocations(words[i + j], depth + 1)
        elif mode == "file" and is_binary(words[i + j]):  # the wrapper script run by a shell
            out.append(words[i + j + 1 :])
        elif mode == "stdin":
            for body in stdin:
                out += _invocations(body, depth + 1)
    elif wrapper in STRING_WRAPPERS and i == len(words) - 1:  # `watch 'compta …'`
        out += _invocations(head, depth + 1)
    elif name == "find":
        j = i + 1
        while j < len(words):
            if words[j] in FIND_EXEC:
                k = j + 1
                while k < len(words) and words[k] not in (";", "+"):
                    k += 1
                out += _from_words(words[j + 1 : k], [], depth + 1)
                j = k
            j += 1
    return out


def _invocations(script: str, depth: int) -> list[list[str]]:
    if depth > MAX_DEPTH:
        return []
    out: list[list[str]] = []
    for cmd in simple_commands(tokenize(script)):
        words = cmd.words + [t for _, t in cmd.redirects if t is not None]
        for w in words:  # substitutions run first, wherever they are
            for sub in w.subs:
                out += _invocations(sub, depth + 1)
        # an unquoted heredoc's substitutions run when the outer shell expands it, whoever reads it
        # (`cat <<EOF`, `bash <<EOF`); a shell reading it then runs the expanded body (`_from_words`)
        for op, _ in cmd.redirects:
            for sub in op.subs if op.expands else ():
                out += _invocations(sub, depth + 1)
        out += _from_words([w.text for w in cmd.words], cmd.stdin_scripts(), depth)
    return out


def compta_invocations(command: str) -> list[list[str]]:
    """Every `compta …` invocation in a shell command line, as argument lists, in order."""
    return _invocations(command, 0)


def shell_script(command: str) -> str | None:
    """The script of a `[/bin/]zsh -c '…'` / `bash -lc '…'` wrapper (Codex runs every command
    this way), or None when the command is not such a wrapper."""
    cmds = simple_commands(tokenize(command.strip()))
    if len(cmds) != 1:
        return None
    words = [w.text for w in cmds[0].words]
    if not words or _name(words[0]) not in SHELLS:
        return None
    mode, i = _shell_mode(words)
    return words[i] if mode == "c" else None


# ───────────────────────────── what an invocation does ─────────────────────────────


@dataclass
class Parsed:
    """An invocation's arguments read as the CLI reads them (commander)."""

    positionals: list[str]  #: the command path and its operands (`["ops", "set", "4100165"]`)
    options: dict[str, list[str | None]]  #: long option name → its values (None for a flag), in order


def parse_args(args: list[str]) -> Parsed:
    """Read `args` with the CLI's option table (`cli_options`), as commander does: an option that
    takes a value consumes the next word even if it starts with "-" (`--memo --dry-run`), or its
    `--opt=value` / `-oVALUE` form; short flags combine (`-yq`); `--` ends the options. The
    options known to the command path read so far (its own and its ancestors') are used, and any
    command's when the path is not known (`compta $cmd …`). Unknown options are flags."""
    table = cli_options()
    commands, aliases = table["commands"], table["aliases"]
    path = ""
    known = dict(commands[""])
    pos: list[str] = []
    opts: dict[str, list[str | None]] = {}
    operands = False  # an operand was read: later words don't descend the command path
    only_operands = False
    i = 0

    def kind(name: str) -> str:
        if name in known:
            return known[name]
        return "value" if name in TAKES_VALUE else "flag"

    def add(name: str, value: str | None) -> None:
        opts.setdefault(aliases.get(name, name), []).append(value)

    while i < len(args):
        a = args[i]
        i += 1
        if only_operands or a == "-" or not a.startswith("-"):
            sub = f"{path} {a}".strip()
            if not operands and not only_operands and sub in commands:
                path = sub
                known.update(commands[sub])
            else:
                operands = True
            pos.append(a)
        elif a == "--":
            only_operands = True
        elif a.startswith("--"):
            name, eq, value = a.partition("=")
            k = kind(name)
            if eq:
                add(name, value)
            elif k == "value" and i < len(args):
                add(name, args[i])
                i += 1
            elif k == "optional" and i < len(args) and not args[i].startswith("-"):
                add(name, args[i])
                i += 1
            else:
                add(name, None)
        else:  # -y, -yq, -ofile, -o file
            for j in range(1, len(a)):
                name = "-" + a[j]
                k = kind(name)
                if k in ("value", "optional"):
                    rest = a[j + 1 :]
                    if rest:
                        add(name, rest)
                    elif i < len(args) and (k == "value" or not args[i].startswith("-")):
                        add(name, args[i])
                        i += 1
                    else:
                        add(name, None)
                    break
                add(name, None)
    return Parsed(pos, opts)


def positionals(args: list[str]) -> list[str]:
    """The command path and operands of an invocation (option values left out)."""
    return parse_args(args).positionals


def has_option(args: list[str], name: str) -> bool:
    """The option `name` (long form) is given, as an option, not as another option's value."""
    return name in parse_args(args).options


def option_value(args: list[str], name: str) -> str | None:
    """The last value given to option `name` (long form), or None."""
    values = [v for v in parse_args(args).options.get(name, []) if v is not None]
    return values[-1] if values else None


def is_executing_write(args: list[str]) -> bool:
    """`compta apply` / `ops set|attach|detach|validate` / `api POST|PUT|PATCH|DELETE` that is not
    a dry run. Planning (`vat check --plan`, `rules apply --plan`, `receipts match --plan`) and
    previews are not."""
    parsed = parse_args(args)
    if "--dry-run" in parsed.options:
        return False
    pos = parsed.positionals
    if not pos:
        return False
    if pos[0] == "apply":
        return True
    if pos[0] == "ops" and len(pos) > 1 and pos[1] in ("set", "attach", "detach", "validate"):
        return True
    return pos[0] == "api" and len(pos) > 1 and pos[1].upper() in ("POST", "PUT", "PATCH", "DELETE")


#: The CLI commands that write through a plan or a direct edit, matched on an invocation's
#: positionals: anchored at the command position by construction (see `is_mutating_command`).
MUTATING_CLI = re.compile(r"^(?:apply|ops\s+(?:set|attach|detach|validate))\b")


def is_mutating_command(command: str) -> bool:
    """A `compta` invocation that can write (apply, ops set/attach/detach/validate) and isn't a dry run."""
    return any(
        not has_option(args, "--dry-run") and MUTATING_CLI.match(" ".join(positionals(args)))
        for args in compta_invocations(command)
    )
