# Security review — M7 Phase 4 (Codex kind corrections and the dead kinds)

- Date: 2026-09-17
- Reviewer: `codex exec -s read-only` 0.154.0 (independent model) against the
  uncommitted working tree (tracked diff plus untracked fixture files); plus a
  maintainer self-review
- Trigger: trust-boundary files changed — `src/runtime/codex/paths.ts`,
  `src/runtime/codex/discovery.ts`, `src/runtime/codex/metadata.ts`,
  `src/discovery/frontmatter.ts`
- Result: 3 "Consider" findings from the independent pass (2 remediated, 1
  dismissed by design with reasoning); no "Act on" findings; the remaining
  categories checked and explicitly clear

## What changed

Issue #73 corrects the Codex kind assignments and settles the dead kinds:
`rules/**` becomes its own `rules` kind (instructional content, not
`permissions`), while a second `permissions` element at `<file>#permissions`
carries only `{ allowCount, denyCount }` counted from each `.rules` file's
content. Top-level `model`, `model_reasoning_effort`, and `service_tier` move
from `compaction-controls` to a `model-configuration` element, and the real
context controls (`model_context_window`, `model_max_output_tokens`,
`model_auto_compact_token_limit`) are read for `compaction-controls`.
`skill-dependencies` is removed as a kind and implemented as
`dependencyNames` frontmatter metadata on the existing `skills` kind;
`multi-agent-configuration` is withdrawn with its classifier row.

## Invariants checked

Read-only, no execution, no symlink traversal, hardlinks / non-regular files
never opened, consent gating unchanged (`.rules` is inside the already-walked
user scope, so no new read path), deny-by-default persistence through the
allowlist and redaction, best effort with recorded completeness, and the
resource ceilings that bound the walk and the frontmatter parse (design doc
§19; roadmap §3.1 / §3.2, ADR 0002).

## Findings and disposition

| #   | Severity | Finding                                                                                                                                                                                        | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Consider | The `permissions` fragment assertion used `toMatchObject`, so a regression could add extra metadata fields (including raw rule content) to the fragment and the test would stay green.         | **Fixed.** `src/runtime/codex/discovery.test.ts` now asserts the fragment metadata with `toEqual({ allowCount, denyCount })`, so any added key turns the test red. The extraction itself already returns only `{ allowCount, denyCount }`, and the rules-element assertion was likewise tightened to exact `{ format: 'rules' }`.                                                                                                                                                                                                                |
| 2   | Consider | `dependencyNames` is newly persisted metadata. It passes the generic redaction pass, but no adapter-level test proved a secret-shaped dependency name is redacted before it reaches the store. | **Fixed.** A discovery test writes a skill declaring a GitHub-token-shaped dependency name and asserts the persisted `dependencyNames` is `['[redacted]']` and that the raw token appears nowhere in the snapshot. `frontmatter.ts` validates a dependency name as a bare identifier and `toSafeMetadata` redacts each value, so this is defence in depth rather than the only guard.                                                                                                                                                            |
| 3   | Consider | The documented layout reconciliation for withdrawn kinds has no executable check or recorded artifact; a future Codex layout could reintroduce a configuration surface without a test failing. | **Dismissed, by design.** This is the explicit decision recorded for issue #73 and in `src/runtime/codex/paths.ts`: fixtures only cover areas the adapter already searches, so a fixture-based test cannot be the trigger — a kind reappearing in an unsearched directory would leave it green. The trigger is the human-invoked layout reconciliation documented in the header, which re-checks the withdrawn kinds when the verified range moves. A versioned layout inventory is a reasonable future hardening and is named here as deferred. |

## Dismissed (checked and clear)

- **Rule content leaving the process.** `permissionCounts` returns only two
  integers; a pattern, command, or argument is never placed in metadata. The
  walking fixture includes a sentinel argument inside a `prefix_rule` pattern
  and a `cmd0` pattern, and both the discovery test and the integration
  `SENTINEL_CODEX_RULE` assertion prove neither the raw `.rules` text nor a
  pattern reaches disk. The `.rules` content is read by the shared walker's
  `describeFile` on bytes it already read and hashed, so no new read is
  introduced.
- **`#permissions` fragment id collision.** The fragment path is
  `<file>#permissions` while the file element path is `<file>`; the full path
  participates in `elementIdFor`, so the two ids differ. A discovery test
  asserts they are not equal, and the existing per-snapshot uniqueness
  assertion still holds. The pre-existing synthetic-fragment convention (shared
  with Claude Code's `settings.json#permissions`) is settled by M8's
  `ElementId` derivation decision (roadmap line 178); this phase adds no new
  collision beyond that convention.
- **Redaction / allowlist coverage of the new keys.** `allowCount`,
  `denyCount`, `dependencyNames`, `contextWindow`, `maxOutputTokens`, and
  `autoCompactTokenLimit` are added to `CODEX_SAFE_METADATA_ALLOWLIST` only;
  `filterToAllowlist` drops everything else, and `dependencyNames` is added to
  the Codex allowlist only (Claude Code drops it). Values pass `redactValue`
  recursively before the allowlist.
- **New read paths / consent.** `.rules` files are inside the existing walked
  `~/.codex/<element-dirs>/**` area, so the read set is unchanged and consent
  gating is untouched. `docs/security/read-paths.md` records this.
- **Unbounded work.** The counts pass is one linear scan over content the walk
  already bounded by `MAX_FILE_BYTES`; dependency names reuse the existing
  `MAX_TOOL_NAMES` / `MAX_TOOL_NAME_LENGTH` ceilings rather than adding a limit,
  so `limitExceededDiagnostic`'s `LimitName` is unchanged. `config.toml` reads
  are unchanged and bounded by `MAX_PARSE_BYTES`.
- **Execution / dynamic loading.** No new API; the no-execution text scan over
  `src/` still passes.

## Verification

- Falsifiability: reverting the counts-only extraction (merging the counts back
  onto the `rules` element) turns the exact `{ format: 'rules' }` assertion red;
  adding a raw pattern to the fragment metadata turns the `toEqual` assertion
  red; persisting a rule pattern turns the sentinel and `cmd0` assertions red;
  dropping `allowCount` from the allowlist turns the `broad-tool-access` test
  red, since the finding can no longer fire; removing the dependency parser
  turns the frontmatter and Codex skill assertions red; changing the fragment
  path to the file path turns the id-inequality assertion red.
- Independent pass: `codex exec -s read-only` reviewed the tracked diff and the
  untracked `rules/` fixture against the invariants above and reported the three
  findings dispositioned here.
- End-to-end: a materialized Codex fixture inspected with
  `node dist/index.js inspect --runtime codex` stores
  `~/.codex/config.toml#model` (`model-configuration`),
  `~/.codex/config.toml#context` (`compaction-controls`, context keys only),
  `~/.codex/rules/default.rules` (`rules`, `{ format: 'rules' }`) and its
  `~/.codex/rules/default.rules#permissions` fragment
  (`{ allowCount: 3, denyCount: 1 }`), with the stored snapshot containing no
  rule pattern, no argument, and no dependency name other than redacted. The
  e2e suite asserts the same through `show --json`.
- Full gate green: `test`, `check`, `format`, `build`, `typecheck:test`, `knip`.
