#!/usr/bin/env python3
"""PreToolUse hard guard for auto-continued Devin sessions (Issue #96).

Vendored from ~/.hermes/scripts/devin_dangerous_guard.py and invoked via
$DEVIN_PROJECT_DIR so the committed .devin/hooks.v1.json stays
self-contained on any clone. Dangerous/permission modes stay unchanged —
this hook is the hard guard for the two commands that must never run
unattended:

  - git push -f / --force / --force-* / +refspec
  - gh pr merge (including through env/sudo/command-style wrappers)

Contract with Devin CLI (Claude-compatible hooks v1):
  - the hook payload arrives on stdin as JSON; the command being considered
    is payload["tool_input"]["command"];
  - stdout is parsed as hookSpecificOutput — emitting a deny decision is
    the explicit block signal;
  - a non-zero exit additionally blocks on harnesses that treat hook
    failure as closed. We emit the deny JSON AND exit 2 so either
    interpretation stops the command.

Anything unparseable falls through to "allow" — the hook guards two known
verbs, it is not a general command sandbox (permission-mode still applies).
A determined adversary can always smuggle shell past a text matcher; this
guard exists to make the obvious forms impossible.
"""

import json
import shlex
import sys

_PUNCT = ";|&"
# Command prefixes that forward their argv to the real verb.
_SIMPLE_WRAPPERS = {"command", "builtin", "exec", "nohup", "nice", "time",
                    "stdbuf", "timeout"}
_ENV_VALUED = {"-u", "--unset", "-C", "--chdir", "-S", "--split-string"}
_SUDO_VALUED = {"-u", "-g", "-h", "-p", "-C", "-T"}


def _deny(reason: str) -> int:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }}, ensure_ascii=False))
    return 2


def _segments(command: str) -> list:
    """Split a command line into pipeline segments on ;, &, | while
    honouring shell quoting — quoted separators must not divide."""
    lexer = shlex.shlex(command or "", posix=True, punctuation_chars=_PUNCT)
    lexer.whitespace_split = True
    try:
        tokens = list(lexer)
    except ValueError:
        return [(command or "").split()]
    segments, cur = [], []
    for tok in tokens:
        if tok and all(c in _PUNCT for c in tok):
            segments.append(cur)
            cur = []
        else:
            cur.append(tok)
    segments.append(cur)
    return segments


def _strip_wrappers(tokens: list) -> list:
    """Peel leading command wrappers so `env FOO=1 gh pr merge` matches."""
    while tokens:
        t = tokens[0]
        if t == "env":
            i = 1
            while i < len(tokens):
                a = tokens[i]
                if a in _ENV_VALUED:
                    i += 2
                elif a.startswith("-") or ("=" in a):
                    i += 1
                else:
                    break
            tokens = tokens[i:]
        elif t == "sudo":
            i = 1
            while i < len(tokens) and tokens[i].startswith("-"):
                i += 2 if tokens[i] in _SUDO_VALUED else 1
            tokens = tokens[i:]
        elif t in _SIMPLE_WRAPPERS:
            tokens = tokens[1:]
        else:
            break
    return tokens


def _is_force_push(tokens: list) -> bool:
    """True when tokens form `git ... push` with a force flag/refspec."""
    if "git" not in tokens or "push" not in tokens:
        return False
    i_git = tokens.index("git")
    try:
        i_push = tokens.index("push", i_git + 1)
    except ValueError:
        return False
    for arg in tokens[i_push + 1:]:
        # --force, --force-with-lease[=...], --force-if-includes, ...
        if arg == "--force" or arg.startswith("--force-"):
            return True
        # Bundled short flags containing f: -f, -fv, -uf, ...
        if (arg.startswith("-") and not arg.startswith("--")
                and "f" in arg[1:]):
            return True
        # +refspec forces a non-fast-forward update.
        if arg.startswith("+"):
            return True
    return False


def _is_gh_pr_merge(tokens: list) -> bool:
    """True for `gh pr merge` allowing leading global flags (-R repo).

    `gh` is located anywhere in the segment — wrapper arguments (e.g.
    `timeout 30 gh pr merge`) must not hide it."""
    if "gh" not in tokens:
        return False
    rest = tokens[tokens.index("gh") + 1:]
    while rest and rest[0].startswith("-"):
        # `gh -R owner/repo pr merge` / `gh --repo=o/r pr merge`
        rest = (rest[1:] if "=" in rest[0]
                else rest[2:] if len(rest) > 1 else [])
    return len(rest) >= 2 and rest[0] == "pr" and rest[1] == "merge"


def is_denied(command: str) -> bool:
    """Classify a shell command string. Split into segments with quoting
    respected, strip wrapper prefixes, and match the two known verbs."""
    for segment in _segments(command):
        tokens = _strip_wrappers(segment)
        # `sh -c '<code>'` / `eval <code>` re-interpret their argument as
        # shell — recurse so the wrapper cannot smuggle a denied verb.
        if tokens and tokens[0] in ("sh", "bash", "zsh"):
            try:
                i = tokens.index("-c")
                code = tokens[i + 1]
            except (ValueError, IndexError):
                code = ""
            if code and is_denied(code):
                return True
        elif tokens and tokens[0] == "eval":
            if is_denied(" ".join(tokens[1:])):
                return True
        if _is_force_push(tokens) or _is_gh_pr_merge(tokens):
            return True
    return False


def main() -> int:
    try:
        raw = sys.stdin.read() if sys.stdin is not None else ""
    except Exception:  # noqa: BLE001 — unreadable stdin must not block
        raw = ""
    try:
        payload = json.loads(raw or "{}")
    except json.JSONDecodeError:
        payload = {}
    command = ""
    if isinstance(payload, dict):
        tool_input = payload.get("tool_input")
        if isinstance(tool_input, dict):
            command = str(tool_input.get("command") or "")
    if is_denied(command):
        return _deny("hard guard: force push / gh pr merge は"
                     " auto-continue セッションでは禁止されています")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
