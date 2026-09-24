# Security review — diagnostic messages keep embedded paths (#179)

- Date: 2026-09-24
- Reviewer: Devin (agent), against the `issue-179-agent` diff
- Trigger: change under `src/redact/**` (`src/redact/output.ts`), a
  trust-boundary path
- Result: no findings; the high-entropy catch-all still covers diagnostic
  messages, scoped so embedded paths survive, and a follow-up narrows the
  `/`-carrying residual the first pass accepted

## Scope and rationale

`redactDiagnostic` previously ran `redactFreeText` (all rules, including the
export-tier high-entropy heuristic) over the whole message. Diagnostic messages
are templates with interpolated filesystem paths, and the high-entropy rule's
character class includes `/`, so a long embedded path was replaced wholesale
with `[redacted]` — data loss that made diagnostics useless (#179).

The change keeps `PATH_RULES` (common + runtime secret shapes) over the whole
message, then applies the high-entropy catch-all per whitespace-delimited
token, skipping tokens that look like paths. A path-bearing token keeps its
segments; any other token still faces the catch-all, so an unlabelled
high-entropy value in a diagnostic message stays masked at export and
persistence. Home-directory collapsing runs last, so a path renders
identically in `message` and in `path`.

The path test was tightened after review: `/` alone no longer exempts a token
(the high-entropy alphabet includes `/`, so a slash-bearing base64 secret
posed as a path and survived). A token now needs a path signal — a leading
`~`/`/`/`.` (a punctuation prefix allowed), a `/~` expansion, a `.` anywhere,
or a second `/` — or it fails closed to the catch-all. The residual is a
secret that itself carries a path marker (≥2 slashes, a `.`, or a leading
separator); it is accepted as below.

## Assessment

| #   | Question                                                                    | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Does scoping the high-entropy rule to non-path tokens let a secret through? | Only a secret that itself carries a path marker — a second `/`, a `.`, or a leading `~`/`/`/`.` — after the marker requirement replaced the bare `/` exemption. A plain slash-bearing base64 value is now masked; a regression test covers it. The residual is theoretical today: every diagnostic construction site (`src/runtime/{claude-code,codex,opencode}/discovery.ts`, `scaffold.ts`, `version-sources.ts`) interpolates only paths, catalog names, and version strings, never raw file or environment content. |
| 2   | Does the change affect persistence or display asymmetry?                    | `redactDiagnostic` is invoked with the channel's level; `PATH_RULES` applies at every level and the catch-all only from `export` up, matching `redactFreeText`'s tiering for non-path text.                                                                                                                                                                                                                                                                                                                             |
| 3   | Home directory still collapsed?                                             | Yes — `redactHomePath` runs after the rules, and a regression test covers a `~`-collapsed path embedded mid-message.                                                                                                                                                                                                                                                                                                                                                                                                    |

## Verification

- Falsifiability: reverting `redactDiagnostic` to `redactFreeText` turns the
  new tests red (embedded path becomes `[redacted]`); dropping the catch-all
  turns the unlabelled-secret test red. The golden `test/golden/inspect.json`
  shows readable paths in diagnostic messages.
- Full gate green: `pnpm test`, `check`, `format`, `build`, `knip`.
