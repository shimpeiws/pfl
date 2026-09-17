# Security review — M7 Phase 2 (Codex config.toml reconciliation)

- Date: 2026-09-17
- Reviewer: `codex exec` 0.154.0 (independent model), against the diff of M7
  Phase 2 (`git diff m7/frontmatter-parser...HEAD`)
- Trigger: trust-boundary changes in `src/runtime/codex/paths.ts` and
  `src/limits.ts`, plus the rewritten `src/runtime/codex/toml.ts` and adapter
- Result: 1 "Act on" finding and 2 "Consider" findings; the Act-on finding and
  one Consider are remediated, the other is dismissed with reasoning

## What changed

Issues #72 and #74 reconcile the Codex adapter with the runtime's actual
`config.toml`: `[sandbox_workspace_write]`, `[projects.*]`,
`[shell_environment_policy]`, `[marketplaces.*]`, `[plugins.*]`, and
`[profiles.*]` are now modelled, every other section is recorded as an
unsupported element, and `~/.codex/agents/` is removed as a search area. The
TOML reader gained section-scoped keys and non-string scalars while keeping its
Map-based, non-recursive, non-merging shape.

## Invariants checked

Read-only, no execution, no symlink traversal, deny-by-default persistence /
safe metadata allowlist, redaction, best effort without silent incompleteness,
and resource ceilings (roadmap §3.1 / §3.2, ADR 0002).

## Findings and disposition

| #   | Severity | Finding                                                                                                                                                                                                     | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Act on   | A multi-line array whose brackets never close was rescanned in full on every continuation line (`arrayIsClosed(buffer)`), which is quadratic on a hostile ≤1 MiB `config.toml` and a CPU denial of service. | **Fixed.** The continuation loop now tracks bracket depth and quote state incrementally (`startArrayScan` / `feedArrayScan`), so each character is visited once. A 20 000-line unterminated array is covered by a timeout test.                                                                                                                                                                                                                 |
| 2   | Consider | Only top-level section names are checked for "modelled vs unsupported": a nested table under a modelled section (`[plugins."evil".hooks]`) is neither modelled nor recorded.                                | **Dismissed with reasoning.** `[plugins.*]`, `[profiles.*]`, `[projects.*]`, and `[marketplaces.*]` children are per-entry data, and plugin-provided harness (the nested `hooks`) is discovered by walking the plugin directory, not by parsing `config.toml`. Every _section_ the issue enumerates is handled; a nested sub-table is not a separate search area, so recording it as an element would claim coverage the adapter does not have. |
| 3   | Consider | The tests pin `serverNames` but not that MCP command/arguments stay unpersisted, so a mutation adding `command` to metadata could pass.                                                                     | **Addressed.** Sentinels were added to the MCP `command` and `args` in both the unit and committed fixtures, and the tests assert they are absent from the snapshot.                                                                                                                                                                                                                                                                            |

## Dismissed (checked and fine)

- **Prototype pollution:** keys and sections live in `Map`s, so `__proto__`
  cannot reach `Object.prototype`; a dedicated test covers it.
- **Allowlist / redaction bypass:** every new metadata key is allowlisted, values
  pass through recursive redaction, and `[shell_environment_policy.set]` values
  are never placed in metadata (only a key count).
- **Read-path omission:** M7 reuses the existing guarded `config.toml` read and
  removes a search area; `docs/security/read-paths.md` reflects both.
- **Execution / dynamic loading:** not present in the changed code.
- **Unbounded recursion / catastrophic regex:** the parser is non-recursive and
  its patterns are linear; the header scan is linear (finding 1 was the only
  complexity gap).

## New limits

`MAX_TOML_SECTION_DEPTH`, `MAX_TOML_ARRAY_ITEMS`, and `MAX_TOML_SCALAR_LENGTH`
are introduced; `docs/design/adr/0002-security-hardening.md` §4 is updated to
record them.

## Verification

- Falsifiability: removing the incremental scan turns the unterminated-array
  timeout test red; adding `command` to MCP metadata turns the sentinel
  assertions red; reverting the section loop drops the unsupported-section test.
- End-to-end: a materialized Codex fixture persists `networkAccess`,
  `writableRootCount`, `pluginNames`, `enabledPluginCount`, `inheritMode`, and
  `setKeyCount`; `[features]` is recorded as unsupported; the shell-environment
  and MCP secrets are absent from the stored snapshot.
- Full gate green: `test` (343), `check`, `format`, `build`, `typecheck:test`,
  `knip`.
