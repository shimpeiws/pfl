# Security review — M7 Phase 5 (Claude Code managed scope, plugins, hooks, and the CLAUDE.md tree)

- Date: 2026-09-17
- Reviewer: `codex exec` 0.154.0 (independent model), two passes against the
  uncommitted diff (`codex exec review --uncommitted`): an initial pass and a
  follow-up after the first remediations; plus a maintainer self-review
- Trigger: trust-boundary changes in `src/runtime/claude-code/paths.ts`,
  `discovery.ts`, `resolve.ts`, `consent.ts`, and the `MAX_ANCESTOR_DIRS` doc in
  `src/limits.ts`
- Result: 3 "P2" findings from the independent passes (2 fixed, 1 dismissed as
  the phase's settled design), the rest checked and dismissed with reasoning

## What changed

Issues #69, #70, and #71 deepen the Claude Code adapter. Discovery now reads the
macOS **managed** scope (`/Library/Application Support/ClaudeCode/CLAUDE.md` and
`settings.json`) and emits `origin: 'managed'`; `.mcp.json` is parsed for server
names instead of only digested; the settings reader keys the approval policy on
`permissions.defaultMode` and records hook matcher strings; `CLAUDE.md` /
`CLAUDE.local.md` are found by one project-subtree walk plus bounded
parent-directory reads; and resolution derives instruction applicability from the
file's directory, computes the `CLAUDE.local.md` shadowing relation, ranks
managed settings highest, and resolves `plugin` instead of `unknown`.

## Invariants checked

Read-only, no execution, no symlink traversal, hardlinks and non-regular files
never opened, consent gating for the managed scope and the parent-directory
reads, bounded upward walk, duplicate-free element ids, deny-by-default
persistence through the allowlist and redaction, best effort with recorded
completeness, and resource ceilings (roadmap §3.1 / §3.2, ADR 0002).

## Findings and disposition

| #   | Severity | Finding                                                                                                                                                                                                                                                                       | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P2       | Reverting `resolve.ts`'s new shadowing logic to ignore element status lets an unavailable `CLAUDE.local.md` (symlink, hardlink, oversized, unreadable) shadow an observed `CLAUDE.md`, reporting a file that was never read as an active override.                            | **Fixed.** `localInstructionShadowing` only seeds a local winner from `status === 'observed'` elements, so a skipped local file is recorded but not in force. A resolve test asserts the base stays `effective` and the skipped local is `unresolved`; removing the guard turns it red.                                                                                                                                                                                                                                                                 |
| 2   | P2       | The managed-scope read used the hard-coded `/Library/Application Support/ClaudeCode` on every platform. On a non-macOS host with that path present, unrelated files would be reported as Claude Code managed configuration even though the scope is documented as macOS-only. | **Fixed.** The default read is gated on `process.platform === 'darwin'` through the exported pure `managedConfigDirFor(platform, override)`; an explicit override (the injectable base) is still read on any platform, which keeps the fixture test hermetic on Linux CI. A unit test pins `linux → null`, `darwin → MANAGED_CONFIG_DIR`, and `linux + override → override`, so the gate is falsifiable without a live `/Library`. The consent prompt lists the locations unconditionally, which over-reports rather than under-reports the read scope. |
| 3   | P2       | (Follow-up pass.) `hookMatchers` is a flat array, so the per-event association between a hook event and its matchers is not persisted; two events with the same matcher list are indistinguishable.                                                                           | **Dismissed as the settled design of this phase.** The brief specifies "`hookMatchers` (the flat array of matcher strings …) and `hookMatcherCount`". A flat list of matcher strings is the minimization the persistence policy wants; per-event structure would persist a nested event→matcher map, a shape the maintainer did not choose. Recorded here rather than silently dropped; a future phase may revisit it.                                                                                                                                  |

## Dismissed (checked and fine)

- **Managed read is gated and never touches `/Library` in tests:** the whole
  managed call sits inside `if (access.allowOutsideProject)` and the discovery
  test injects a temp base, so no test writes to or reads `/Library`; the
  macOS-only default is a one-line platform check.
- **Parent read is bounded and consent-gated:** the upward loop is inside the
  same consent gate, stops at the filesystem root, and is capped at
  `MAX_ANCESTOR_DIRS` with a `limit-exceeded` diagnostic naming the constant. A
  discovery test places a file `MAX_ANCESTOR_DIRS + 1` levels up and asserts it
  is not read; the consent integration test asserts no `../` element without a
  grant and one with it, so the deny assertion is not vacuous.
- **Duplicate element ids between the instruction walk and `.claude/**`:** the
  instruction walk excludes the project config directory by path in `selectFile`,
  and the old root-only per-file loop was removed, so the subtree walk is the
  single producer. A discovery test asserts unique ids and that a `CLAUDE.md`
  inside the skills area is recorded once, as `skills`.
- **No raw content, hook commands, MCP commands, or env values persisted:** hook
  commands, types, and timeouts never enter metadata (`matcherStrings` returns
  only strings from the `matcher` key); the MCP reader emits `serverNames` only;
  the integration sentinel suite covers the new fixture files
  (`SENTINEL_CLAUDE_MCP_*`, `SENTINEL_CLAUDE_LOCAL`, `SENTINEL_CLAUDE_PARENT`,
  `SENTINEL_CLAUDE_PLUGIN`).
- **Symlinked/hardlinked fixed reads:** the managed files, `.mcp.json`, and the
  parent instruction files all go through `addKnownFile` /
  `collectMcpFile` / `collectSettings`, which refuse a symlink at the leaf, a
  symlinked component below the base, a hardlink, and a non-regular file. The
  existing symlinked-settings tests still pass.
- **Unbounded work:** the project-wide instruction walk is bounded by the walk's
  entry, depth, and byte ceilings; `selectFile` rejects non-instruction files
  before they are `lstat`ed or read, and `.git` / `node_modules` are pruned.
- **Execution / dynamic loading:** not present in the changed code; the
  no-execution text scan over `src/` still passes.

## Follow-up (out of scope for this phase)

`overrideShadowing` in `src/runtime/codex/resolve.ts` has the same latent
behaviour finding 1 addressed: a skipped `AGENTS.override.md` can still shadow
the base `AGENTS.md`. It is pre-existing Phase 3 code, not part of this diff, and
is left for a Codex-phase follow-up rather than changed here.

## Verification

- Falsifiability (verified by actually reverting each guard and watching the
  suite go red): removing the `status === 'observed'` guard turns the
  unavailable-local resolve test red; reverting `managedConfigDirFor` to always
  return `MANAGED_CONFIG_DIR` turns the platform-gate test red. By inspection:
  removing the consent gate turns the deny-parent/deny-managed discovery test
  red; removing the `MAX_ANCESTOR_DIRS` bound turns the truncation test red;
  restoring the root-only instruction loop turns the uniqueness test red;
  removing the `.claude/` path exclusion turns the skills-area uniqueness test
  red; adding `permissionMode` back turns the allowlist test red.
- Full gate green: `test` (380 tests), `check`, `format`, `build`,
  `typecheck:test`, `knip`.
- End-to-end: a materialized Claude fixture inspected with the built CLI stores
  `.mcp.json#mcpServers` (`serverNames: ["fixture"]`),
  `.claude/settings.json#defaultMode` (`approval-policy`, `acceptEdits`),
  `.claude/settings.json#hooks` (matchers `startup|resume|compact`, `Bash`),
  `~/.claude/plugins/market/plug/plugin.json` (`plugin`) alongside its supplied
  `skills` and `subagents`, and the `CLAUDE.md` tree — root `shadowed` by
  `CLAUDE.local.md`, `docs/CLAUDE.md` effective as `directory-subtree (docs)`,
  `../CLAUDE.md` global. The managed elements are proven by the injected-base
  unit test, since `/Library/Application Support/ClaudeCode` is absent on the
  test host and the e2e run may not redirect a system path.
