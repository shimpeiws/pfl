# Security review — diagnostic messages keep embedded paths (#179)

- Date: 2026-09-24
- Reviewer: Devin (agent), against the `issue-179-agent` diff
- Trigger: change under `src/redact/**` (`src/redact/output.ts`), a
  trust-boundary path
- Result: no findings; the change narrows which rules apply to diagnostic
  messages and cannot weaken masking of known secret shapes

## Scope and rationale

`redactDiagnostic` previously ran `redactFreeText` (all rules, including the
export-tier high-entropy heuristic) over the whole message. Diagnostic messages
are templates with interpolated filesystem paths, and the high-entropy rule's
character class includes `/`, so a long embedded path was replaced wholesale
with `[redacted]` — data loss that made diagnostics useless (#179).

The change applies `PATH_RULES` (common + runtime secret shapes, minus the
high-entropy catch-all) plus home-directory collapsing to the message instead.
This mirrors the treatment `redactPath` already gives `diagnostic.path`, so a
path renders identically in `message` and in `path`.

## Assessment

| #   | Question                                                                   | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Does dropping the high-entropy rule from diagnostics let a secret through? | No more than before for paths: `diagnostic.path` has always used `PATH_RULES`, and the same secret-bearing path now survives identically in `message`. Known secret shapes (tokens, `sk-…`, `sess-…`, auth headers) are still masked by the common/runtime rules in `PATH_RULES`. A high-entropy token embedded in a diagnostic message is no longer caught by the catch-all — same residual risk `diagnostic.path` already carries, accepted to keep paths readable. This is theoretical today: every diagnostic construction site (`src/runtime/{claude-code,codex,opencode}/discovery.ts`, `scaffold.ts`, `version-sources.ts`) interpolates only paths, catalog names, and version strings, never raw file or environment content. |
| 2   | Does the change affect persistence or display asymmetry?                   | `redactDiagnostic` is invoked with the channel's level; the rule set is now level-independent `PATH_RULES`, matching `redactPath`'s existing behavior for the sibling `path` field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 3   | Home directory still collapsed?                                            | Yes — `redactHomePath` runs after the rules, and a regression test covers a `~`-collapsed path embedded mid-message.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Verification

- Falsifiability: reverting `redactDiagnostic` to `redactFreeText` turns the
  new tests red (embedded path becomes `[redacted]`); the golden
  `test/golden/inspect.json` now shows readable paths in diagnostic messages.
- Full gate green: `pnpm test` (616), `check`, `format`, `build`, `knip`.
