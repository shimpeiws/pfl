# Security review — M7 Phase 3 (Codex project skills and the AGENTS.md tree)

- Date: 2026-09-17
- Reviewer: `codex exec` 0.154.0 (independent model), two passes against the
  uncommitted diff (`codex exec review --uncommitted`): an initial pass and a
  follow-up after the first remediations; plus a maintainer self-review
- Trigger: trust-boundary changes in `src/runtime/codex/discovery.ts`
  (project-subtree walk, parent-directory walk) and `src/discovery/walk.ts`
  (`selectFile`, `pruneDirectories`), and a new `MAX_ANCESTOR_DIRS` ceiling
- Result: 1 "Act on" + 1 "P2" finding from the independent passes (both fixed),
  1 self-review finding (fixed), the rest checked and dismissed with reasoning

## What changed

Issue #75 makes the Codex adapter resolve the instruction tree instead of the
single root pair: project-scoped skills (`<root>/.codex/skills/**`), `AGENTS.md`
and `AGENTS.override.md` found anywhere in the project subtree, and the same two
files read from the project's parent directories (an out-of-project read).
Resolution derives instruction applicability from the file's directory
(`global` for `../…`, `project` for the root, `directory-subtree` for a nested
file) and keeps `overrideShadowing` keyed on the directory.

## Invariants checked

Read-only, no execution, no symlink traversal, hardlinks and non-regular files
never opened, consent gating for out-of-project reads, deny-by-default
persistence through the allowlist and redaction, best effort with recorded
completeness, and resource ceilings (roadmap §3.1 / §3.2, ADR 0002).

## Findings and disposition

| #   | Severity | Finding                                                                                                                                                                                                                                                                                                                                       | Disposition                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Act on   | The project-wide instruction walk read and hashed every regular file before `instructionKindForPath` filtered the entries. On a large tree this spends the `MAX_WALK_ENTRIES` budget and the per-file read on unrelated content, can miss a legitimate `AGENTS.md` later in traversal order, and reads arbitrary project files for no result. | **Fixed.** `walkHarnessPaths` gained `selectFile`: a rejected regular file is neither `lstat`ed, opened, nor listed. The instruction walk passes `selectFile: instructionKindForPath !== undefined`, so only `AGENTS.md` / `AGENTS.override.md` candidates are read. A walk test proves with a `describeFile` spy that no unselected file is read; `docs/security/read-paths.md` describes the narrowed read. |
| 2   | Consider | A duplicate element id: a file at `.codex/skills/AGENTS.md` would be recorded twice with the same runtime + origin + path — once as a `skills` element by the skills walk and once as an `instructions` element by the instruction walk. A duplicate id breaks the id-per-element assumption that diff and graph rely on.                     | **Fixed.** The instruction walk excludes the project config directory by _path_ (`selectFile` rejects `<project>/.codex/…`), so its files stay the skills walk's. The new discovery test asserts every element id is unique, and that an `AGENTS.md` inside the skills area is recorded exactly once, as `skills`.                                                                                            |
| 3   | Consider | The parent-directory read is gated on `allowOutsideProject`, which the current `codex:user` grant provides, but the consent prompt did not list the read, so the prompt under-reported the read scope against the read-path inventory (roadmap S2).                                                                                           | **Addressed.** The consent group gained `../ (parent directories, bounded)` under **External references**, the literal expectation in `consent.test.ts` moved with it, and `docs/security/read-paths.md` classifies the read `external-gated` and states how it is gated. The M8 taxonomy assigns it its final scope; it is not left implicit.                                                                |
| 4   | P2       | (Follow-up pass.) Excluding the project config directory by _name_ in `pruneDirectories` would skip every directory named `.codex` anywhere in the tree, silently omitting a nested instruction file in a subdirectory that happens to share the name.                                                                                        | **Fixed.** `.codex` left the name-based prune list; the exclusion is path-aware in `selectFile` (`<project>/.codex/…` only). A discovery test places `docs/.codex/AGENTS.md` and asserts it is discovered, which fails under the name-based prune.                                                                                                                                                            |

## Dismissed (checked and fine)

- **Symlinked instruction file or parent directory:** the parent walk reads each
  ancestor with `inspectFileTarget(dir, …)`, which refuses a symlink at the leaf
  and refuses any symlinked component below the read's base; ancestor paths are
  lexical `dirname`s of the canonical project root, so no symlinked component is
  traversed. A symlink _at_ a scope base is a prefix by design (ADR 0002 §1).
- **Unbounded upward walk:** bounded by `MAX_ANCESTOR_DIRS`; reaching the
  filesystem root ends it naturally and hitting the ceiling records a
  `limit-exceeded` diagnostic naming the constant. The bound test fails if the
  ceiling is removed.
- **Missing consent gate:** the whole ancestor loop is inside
  `if (access.allowOutsideProject)`. The deny test asserts no `../` element and no
  parent sentinel on disk; the grant test asserts a `../` element exists, so the
  deny assertion is not vacuous.
- **Duplicate id from the root-file loop:** the old per-file root loop was
  removed, so the subtree walk is the single producer of the root elements; a
  uniqueness assertion pins it. The walk's `record` also dedupes by relative
  path.
- **Metadata / redaction bypass:** instruction elements carry only
  `metadataForPath` (the file format) and are digested, never read into metadata;
  frontmatter extraction is disabled for the instruction walk so unrelated files
  are not parsed as instructions. Parent files reuse `addKnownFile`, the same
  guarded path as every other fixed read. The integration sentinel tests cover
  the new files.
- **Execution / dynamic loading:** not present in the changed code; the
  no-execution text scan over `src/` still passes.
- **Unbounded recursion / catastrophic work:** the walk is iterative, bounded by
  entry, depth, and byte ceilings; `selectFile` and `pruneDirectories` only
  reduce the work.

## New limits

`MAX_ANCESTOR_DIRS` (16) is introduced; `docs/design/adr/0002-security-hardening.md`
§4 records it as a walk-level ceiling of the same kind as `MAX_WALK_ENTRIES`.

## Verification

- Falsifiability: reverting the `dirname` guard in `overrideShadowing` turns the
  different-directory shadow test red; removing the consent gate turns the
  deny-parent test red; removing the `MAX_ANCESTOR_DIRS` bound turns the
  truncation test red; removing the prune or `selectFile` handling turns the walk
  tests red; restoring the old root-file loop turns the uniqueness test red;
  restoring the name-based `.codex` prune turns the nested-config-name test red;
  removing the path-aware exclusion turns the skills-area uniqueness test red.
- End-to-end: a materialized Codex fixture with consent resolves
  `.codex/skills/project-skill/SKILL.md` (`skills`, effective, `project`),
  `docs/AGENTS.md` (`directory-subtree (docs)`), `../AGENTS.md` (`global`,
  shadowed by `../AGENTS.override.md`), and the root `AGENTS.md` (shadowed by the
  root override) while `docs/AGENTS.md` stays effective. Without consent the
  `../`-prefixed elements are absent and a `consent-not-granted` diagnostic is
  raised.
- Full gate green: `test`, `check`, `format`, `build`, `typecheck:test`, `knip`.
