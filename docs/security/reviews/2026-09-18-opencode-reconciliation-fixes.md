# Security review — OpenCode 1.18.31 reconciliation adapter fixes (#149–#151)

- Date: 2026-09-18
- Reviewer: independent adversarial review (Claude Code CLI) plus maintainer
  disposition.
- Trigger: `src/runtime/opencode/paths.ts` and `src/runtime/opencode/discovery.ts`
  changed (trust-boundary paths).
- Result: no new read path; no target is opened; persistence stays deny-by-default.

## What changed

The #144 reconciliation corrected three surfaces the M9 adapter had modelled
from the pre-reconciliation rows, and this change aligns the adapter:

- **#149** — `mode(s)/` files are recorded as `agents` (primary) instead of
  `unsupported-by-adapter`.
- **#150** — `references` is read in the runtime's object form (keyed by alias),
  one opaque declaration per alias.
- **#151** — the `skills` config key's `paths`/`urls` are recorded as declared,
  never-opened skill sources.

## Trust-boundary check

- **No new read.** `mode(s)/` files were already read as regular files by the
  walk (they were `.md` candidates); only their classification changed. The
  `references` and `skills` values come from the config file already read, and
  their targets are **not** opened: no path, glob, URL, or repository is resolved
  or fetched.
- **Persistence is still deny-by-default.** A `mode(s)/` element now persists a
  digest, size, and the allowlisted frontmatter metadata (key names, description
  length, `agentMode`) instead of being an unsupported element with none — a
  strictly smaller change than it looks, and no content. The declarations persist
  only a derived `declaredTargetKind` (`path`/`glob`/`url`/`absolute-path`/
  `repository`), never the target string, so a credential-bearing reference
  cannot reach the store.
- **No symlink/hardlink/non-regular change.** The element walk and guarded reads
  are unchanged; `kindForEntry` still re-applies `selectFile`, so a symlink not
  matching the directory's file pattern is not recorded.
- **Array-form `references`** (which the runtime rejects as invalid config) is
  recorded `unsupported` rather than dropped, consistent with the best-effort
  invariant.

## Findings

| #   | Severity | Finding                                                                                                                                                  | Disposition                                                                                                                              |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Medium   | `referenceStringKind` classified a relative path (`../refs`) as a `repository` because the `owner/repo` shorthand test did not exclude a leading `.`/`~` | Fixed: the shorthand regex now requires a non-`.`/`~` first character; covered by the `.opencode/opencode.jsonc#references.refpath` test |
| 2   | Low      | A `mode(s)/` element now persists a digest it did not before                                                                                             | Accepted and documented: the file was already read; the digest is a structural fact, not content                                         |
| 3   | Low      | `references`/`skills` are declaration arrays that could be large                                                                                         | Already capped at `MAX_CONFIG_ITEMS` with a truncation diagnostic                                                                        |

## Verification

- Full gate green: `test` (63 files, 576 tests), `check`, `format`, `build`,
  `typecheck:test`, `knip`, `test:coverage`.
- The reconciliation remains the source of the corrected rows
  (`docs/design/opencode-model.md` §12).
