# Read-path inventory

This document is the closed set of filesystem read paths in the shipped `pfl`
code, and the classification each one carries against the consent boundary
(design doc §19) and the security invariants. It is the prerequisite the M6
acceptance criteria call for: consent wording cannot be derived from the code
until the set of reads is known, and M8 consumes this inventory to place the
consent choke point.

- Scope: every read in `src/` (excluding `*.test.ts`), as of M6 Phase 0.
- Adapters: `claude-code`, `codex`.
- Each later adapter extends this document as part of its own security review.

## Classification vocabulary

| Term                 | Meaning                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **project-implicit** | A read inside the project root. No consent required (design doc §19).                                                    |
| **user-scope**       | A read under the runtime's user harness (`~/.claude`, `~/.codex`). Requires the `<runtime>:user` grant.                  |
| **install-scope**    | Runtime installation / version metadata. Requires the `<runtime>:install` grant.                                         |
| **store**            | A read of `pfl`'s own `~/.pfl` storage. No consent gate; artifact ids are charset-validated.                             |
| **implicit-git**     | Project-identity reads kept project-local and implicit (ADR 0002 §2).                                                    |
| **gated-git**        | Project-identity reads outside the root (a `.git` file's `gitdir:`, an ancestor `.git`). Gated once M6 lands the S5 fix. |

Guard vocabulary: **lstat** = the target is `lstat`ed and a symlink is refused
before any content read; **realpath** = canonical comparison only; **—** = none.

## Reads

### `discovery/walk.ts`

| Line | Read                            | Guard                                                      | Classification                |
| ---- | ------------------------------- | ---------------------------------------------------------- | ----------------------------- |
| 54   | `lstat` of a search-area root   | — (is the guard)                                           | project-implicit / user-scope |
| 93   | `readdir` a walked directory    | realpath containment; never recurses into a symlink        | project-implicit / user-scope |
| 138  | `readFile` a regular file entry | lstat via `dirent.isFile()`, ancestor realpath containment | project-implicit / user-scope |

M6 adds: refuse regular files with `lstat().nlink > 1` (S3); refuse to open
non-regular entries (already typed `unknown`); enforce the entry, depth, and
per-file-byte limits (S7).

### `discovery/project-identity.ts`

| Read                                                     | Guard                               | Classification |
| -------------------------------------------------------- | ----------------------------------- | -------------- |
| `realpath` of cwd / git root                             | — (canonicalisation)                | implicit       |
| `lstat` of `.git` at the project root                    | lstat, not stat                     | implicit-git   |
| `readFile` a `.git` **directory**'s `config` at the root | lstat + isDirectory                 | implicit-git   |
| `lstat` of an ancestor `.git` above the root             | lstat, not stat                     | **gated-git**  |
| `readFile` a `.git` **file**                             | lstat + isFile + `allowExternalGit` | **gated-git**  |
| `readFile` `commondir`                                   | `allowExternalGit`                  | **gated-git**  |
| `readFile` `config` under the resolved common dir        | `allowExternalGit`                  | **gated-git**  |

`resolveProjectContext(cwd, { allowExternalGit })` defaults to `false` (fail
closed). `runInspect` resolves consent first and passes
`access.allowOutsideProject`; read commands pass `hasAnyUserConsent(home)`,
because a project id is shared across runtimes. Before consent, a `.git` file's
`gitdir:` and any ancestor `.git` are not read, so a linked worktree or a run
from a subdirectory falls back to the canonical path. Reclamation of a
path-derived history is M8's root index (ADR 0002 §2).

### `discovery/consent.ts`

| Line | Read                                 | Guard | Classification                          |
| ---- | ------------------------------------ | ----- | --------------------------------------- |
| 34   | `readFile` `~/.pfl/permissions.json` | —     | store (is the consent mechanism itself) |

### `util/fs.ts`

| Line | Read                                        | Guard                                         | Classification                 |
| ---- | ------------------------------------------- | --------------------------------------------- | ------------------------------ |
| 15   | `realpath` (as far as exists)               | — (canonicalisation)                          | mixed (identity + containment) |
| —    | `lstat` component walk                      | `checkSymlinkAncestors` / `inspectFileTarget` | scope-base ancestor guard      |
| —    | `lstat` in `pathExists`                     | leaf-only; symlink counts as absent           | install-scope                  |
| —    | `lstat` + `readdir` in `readDirectoryNames` | leaf-only; a symlinked dir yields `[]`        | install-scope                  |

`inspectFileTarget(absPath, baseDir)` refuses a symlink at any component under
`baseDir` (excluding `baseDir` itself), a non-regular file, and a hardlink, and
reports the size for the caller to bound. `readTextFileGuarded` builds on it.

### `runtime/claude-code`

| Location       | Read                                               | Guard                              | Classification                |
| -------------- | -------------------------------------------------- | ---------------------------------- | ----------------------------- |
| `detect.ts`    | `lstat` of `~/.local/share/claude`, `~/.local/bin` | non-following leaf                 | install-scope                 |
| `detect.ts`    | `lstat` + `readdir` of `.../claude/versions`       | non-following leaf                 | install-scope                 |
| `detect.ts`    | `readFile` `~/.claude/.last-update-result.json`    | `readTextFileGuarded` (leaf guard) | install-scope                 |
| `discovery.ts` | `readFile` known instruction/MCP files             | `inspectFileTarget(root, …)`       | project-implicit / user-scope |
| `discovery.ts` | walk `.claude/**` and `~/.claude/<dirs>/**`        | walk guards                        | project-implicit / user-scope |
| `discovery.ts` | `readFile` `settings.json`, `settings.local.json`  | `readTextFileGuarded` + scope base | project-implicit / user-scope |
| `discovery.ts` | `readFile` `~/.claude.json`                        | `readTextFileGuarded` (base: home) | user-scope                    |

### `runtime/codex`

| Location       | Read                                           | Guard                              | Classification                |
| -------------- | ---------------------------------------------- | ---------------------------------- | ----------------------------- |
| `detect.ts`    | `lstat` + `readdir` of `~/.codex/.../releases` | non-following leaf                 | install-scope                 |
| `detect.ts`    | `lstat` of the install dirs                    | non-following leaf                 | install-scope                 |
| `discovery.ts` | `readFile` known instruction files             | `inspectFileTarget(root, …)`       | project-implicit / user-scope |
| `discovery.ts` | walk `~/.codex/<dirs>/**`                      | walk guards                        | user-scope                    |
| `discovery.ts` | `readFile` `config.toml`                       | `readTextFileGuarded` + scope base | user-scope                    |
| `discovery.ts` | `readFile` `hooks.json`                        | `readTextFileGuarded` + scope base | user-scope                    |

### `snapshot/store.ts`

| Line | Read                               | Guard                                       | Classification |
| ---- | ---------------------------------- | ------------------------------------------- | -------------- |
| 214  | `readFile` `latest`                | `lstat`: symlink / non-regular / size guard | store          |
| 311  | `readdir` an artifact dir          | —                                           | store          |
| 335  | `readFile` an artifact             | `lstat`: symlink / non-regular / size guard | store          |
| 503  | `access` (existing-artifact probe) | —                                           | store          |

Path traversal is blocked by `SAFE_SEGMENT` validation of every id that becomes
a path segment. M6 adds the artifact size limit (S7), a symlink / non-regular
refusal (`MAX_ARTIFACT_BYTES`), and deepens `isObservedSnapshot` validation
(S11).

## Correspondence to consent scopes

M8 freezes `--allow-scope <runtime>:<scope>`. The scope names map onto this
inventory:

- `<runtime>:user` — every **user-scope** row above for that runtime.
- `<runtime>:install` — every **install-scope** row above for that runtime.

External `.git` references are not a scope: under ADR 0002 §2 they are not read
before consent at all. Project-local reads (**project-implicit**, **store**,
**implicit-git**) need no grant.

## Extending this inventory

A new adapter adds its read paths to a new section here, marked with the same
classification, as part of its mandatory pre-merge security review. The M8
choke-point test is parameterised by this inventory, so "no inventoried path is
reachable without a grant covering it" continues to hold for adapters that did
not exist when the test was written.
