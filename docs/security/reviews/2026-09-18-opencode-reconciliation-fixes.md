# Security review — OpenCode 1.18.31 reconciliation adapter fixes (#149–#151)

- Date: 2026-09-18
- Reviewer: independent adversarial review (Claude Code CLI) plus maintainer
  disposition.
- Trigger: `src/runtime/opencode/paths.ts` and `src/runtime/opencode/discovery.ts`
  changed (trust-boundary paths).
- Result: no new filesystem read and no target is opened; the change adds one
  bounded metadata parse and persists already-computed digests. Persistence stays
  deny-by-default.

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

- **No new filesystem read.** The shared walk computes a digest for every
  regular file it reads, independent of `extractFrontmatter` (that flag only
  gates the optional metadata callback). A `mode(s)/` `.md` file was already read
  and digested before this change; the pre-change `unsupported: true` early-return
  discarded the digest, and the change now keeps it. The file is not read a
  second time.
- **One added bounded parse.** `mode(s)/` moved from `extractFrontmatter: false`
  to `true`, so a frontmatter parse now runs on those files. It is bounded by the
  same walk ceilings as every other element file (`MAX_FILE_BYTES` at the read,
  `MAX_PARSE_BYTES` in the reader) and extracts only structural facts.
- **No target is opened.** The `references` and `skills` values come from the
  config file already read; their targets are never resolved, opened, globbed, or
  fetched. `recordReferences`, `recordSkillSources`, `referenceTargetKind`,
  `referencePathKind`, and `referenceStringKind` call only regex/property access
  and reach `buildObservedElement` with `toSafeMetadata({ declaredTargetKind })`.
- **Persistence is deny-by-default.** Declarations persist only a derived
  `declaredTargetKind` (`path`/`glob`/`url`/`absolute-path`/`repository`/`other`),
  never the target string. The **alias** (the object key) _is_ persisted, as a
  key name in `source.path`, under the same rule as an unknown config key name;
  it is not a read target. A `mode(s)/` element persists a digest, size, and the
  allowlisted frontmatter metadata — no content.
- **Array-form `references`** (which the runtime rejects as invalid config) and a
  malformed `skills` shape are recorded `unsupported` rather than dropped,
  consistent with the best-effort invariant.
- **No symlink/hardlink/non-regular change.** `kindForEntry` still re-applies
  `selectFile` first, so a symlink not matching the directory's file pattern is
  not recorded. A symlink that does match is recorded `skipped` and never
  followed; it takes the directory default for its kind, like a regular file with
  no frontmatter.

## Note on the #94 inventory

The #94 read-path inventory lists OpenCode's element-directory walk generically
(`walk <root>/.opencode/<element-dirs>/**`), which already covers `mode(s)/`;
no inventory row is added or changed. The walk's `unsupported` branch is no
longer passed by any OpenCode call (`kindForEntry` no longer returns `unknown`);
OpenCode's `unsupported` elements now come from config-key/declaration shapes,
which the `security-invariants` test pins.

## Findings

| #   | Severity | Finding                                                                                                                                                         | Disposition                                                                                                                                 |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | High     | `referenceTargetKind` classified `{ "path": "docs/refs" }` as a `repository` because the `owner/repo` shorthand rule was applied to an explicitly-declared path | Fixed: the object's `path` key now uses a path-only classifier (`referencePathKind`); the shorthand heuristic applies only to string values |
| 2   | High     | Adding `skills` to the modelled keys removed the visibility a malformed `skills` shape had as an unknown key                                                    | Fixed: unknown sub-keys and non-array `paths`/`urls` are recorded `unsupported`                                                             |
| 3   | Low      | A `mode(s)/` element now persists a digest (and adds a frontmatter parse) it did not before                                                                     | Disclosed above: the file was already read and the digest computed; only the parse is new, and it is bounded                                |
| 4   | Low      | Two long aliases sharing a truncated prefix could collide on `source.path`                                                                                      | Fixed: the fragment includes the entry index (`references.<i>.<alias>`)                                                                     |
| 5   | Low      | Declaration arrays and the `skills` sub-key loop could be large                                                                                                 | Capped: `paths`/`urls` list entries and the sub-key loop both iterate `MAX_CONFIG_ITEMS` with a truncation diagnostic                       |

## Verification

- Full gate green: `test` (63 files, 576 tests), `check`, `format`, `build`,
  `typecheck:test`, `knip`, `test:coverage`.
- The reconciliation remains the source of the corrected rows
  (`docs/design/opencode-model.md` §12).
