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

| Term                 | Meaning                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **project-implicit** | A read inside the project root. No consent required (design doc §19).                                                               |
| **user-scope**       | A read under the runtime's user harness (`~/.claude`, `~/.codex`). Requires the `<runtime>:user` grant.                             |
| **install-scope**    | Runtime installation / version metadata. Requires the `<runtime>:install` grant.                                                    |
| **store**            | A read of `pfl`'s own `~/.pfl` storage. No consent gate; artifact ids are charset-validated.                                        |
| **implicit-git**     | Project-identity reads kept project-local and implicit (ADR 0002 §2).                                                               |
| **gated-git**        | Project-identity reads outside the root (a `.git` file's `gitdir:`, an ancestor `.git`). Gated once M6 lands the S5 fix.            |
| **external-gated**   | A read above the project root (a parent-directory `AGENTS.md`). Gated on out-of-project consent and bounded by `MAX_ANCESTOR_DIRS`. |

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

M7 adds no new read here. It adds an optional `describeFile(relativePath, content)`
callback that runs on the bytes the walk already read to hash, so
content-derived structural metadata (frontmatter keys, tool names, lengths) can
be resolved without exposing the bytes. Only the callback's allowlisted,
redacted record is attached to the entry; raw content never leaves the walk, a
throwing callback is a diagnostic rather than an abort, and the metadata output
is bounded by the `MAX_FRONTMATTER_KEYS` / `MAX_TOOL_NAMES` /
`MAX_TOOL_NAME_LENGTH` ceilings in `src/limits.ts`. M7 also adds
`pruneDirectories` (`.git`, `node_modules`): a pruned directory is neither
recorded nor descended into, so a project-wide walk does not read a
version-control or dependency tree. It adds `selectFile`: a rejected regular
file is neither read nor recorded, so a search for a few known filenames
(`AGENTS.md`) does not open every file in the tree.

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

| Read                                 | Guard                                        | Classification                          |
| ------------------------------------ | -------------------------------------------- | --------------------------------------- |
| `readFile` `~/.pfl/permissions.json` | ancestor guard (base: home); symlink refused | store (is the consent mechanism itself) |

The consent writer applies the same guard before writing, so a symlinked
`~/.pfl` or `permissions.json` is neither read nor written (roadmap S10).

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

| Location       | Read                                                      | Guard                              | Classification                |
| -------------- | --------------------------------------------------------- | ---------------------------------- | ----------------------------- |
| `detect.ts`    | `lstat` of `~/.local/share/claude`, `~/.local/bin/claude` | ancestor guard (base: home)        | install-scope                 |
| `detect.ts`    | `lstat` + `readdir` of `~/.local/share/claude/versions`   | ancestor guard (base: home)        | install-scope                 |
| `detect.ts`    | `readFile` `~/.claude/.last-update-result.json`           | `readTextFileGuarded` (leaf guard) | install-scope                 |
| `discovery.ts` | `readFile` known instruction/MCP files                    | `inspectFileTarget(root, …)`       | project-implicit / user-scope |
| `discovery.ts` | walk `.claude/**` and `~/.claude/<dirs>/**`               | walk guards                        | project-implicit / user-scope |
| `discovery.ts` | `readFile` `settings.json`, `settings.local.json`         | `readTextFileGuarded` + scope base | project-implicit / user-scope |
| `discovery.ts` | `readFile` `~/.claude.json`                               | `readTextFileGuarded` (base: home) | user-scope                    |

### `runtime/codex`

| Location       | Read                                                               | Guard                                                                                                                            | Classification                |
| -------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `detect.ts`    | `lstat` + `readdir` of `~/.codex/packages/standalone/releases`     | ancestor guard (base: `~/.codex`)                                                                                                | install-scope                 |
| `detect.ts`    | `lstat` of `~/.codex/packages/standalone/releases`, `…/standalone` | ancestor guard (base: `~/.codex`)                                                                                                | install-scope                 |
| `discovery.ts` | `readFile` known instruction files                                 | `inspectFileTarget(root, …)`                                                                                                     | project-implicit / user-scope |
| `discovery.ts` | walk `<root>/**` for `AGENTS.md` / `AGENTS.override.md`            | walk guards; `selectFile` reads only those names, excluding the project config directory by path; `.git` / `node_modules` pruned | project-implicit              |
| `discovery.ts` | walk `<root>/.codex/skills/**`                                     | walk guards                                                                                                                      | project-implicit              |
| `discovery.ts` | `readFile` parent-directory `AGENTS.md` / `AGENTS.override.md`     | `inspectFileTarget(dir, …)`; consent-gated; `MAX_ANCESTOR_DIRS`                                                                  | **external-gated**            |
| `discovery.ts` | walk `~/.codex/<dirs>/**`                                          | walk guards                                                                                                                      | user-scope                    |
| `discovery.ts` | `readFile` `config.toml`                                           | `readTextFileGuarded` + scope base                                                                                               | user-scope                    |
| `discovery.ts` | `readFile` `hooks.json`                                            | `readTextFileGuarded` + scope base                                                                                               | user-scope                    |

M7 models more of `config.toml` (`[sandbox_workspace_write]`, `[projects.*]`,
`[shell_environment_policy]`, `[marketplaces.*]`, `[plugins.*]`, `[profiles.*]`)
and records every other section as `unsupported`. The read is unchanged — the
same single guarded `readFile` — and `[shell_environment_policy.set]` values are
never persisted, only their key count. M7 also removes `~/.codex/agents/` as a
search area (it is absent in the verified range), so the walk covers fewer
directories, not more.

M7 Phase 3 adds two project-scoped read paths and one gated one. Project-scoped
skills are walked under `<root>/.codex/skills/**`, and `AGENTS.md` /
`AGENTS.override.md` are found by a project-subtree walk that prunes `.git`,
`node_modules`, and the project config directory. Both are project-implicit.
`AGENTS.md` is also read from the project's parent directories, one directory at
a time up to `MAX_ANCESTOR_DIRS` (16): that is **external-gated**, refused
without out-of-project consent, recorded as `../AGENTS.md` … , and never follows
a symlink (`inspectFileTarget` refuses one at the leaf). A project deeper than
the ceiling reports a `limit-exceeded` diagnostic naming `MAX_ANCESTOR_DIRS`
rather than silently dropping its ancestors.

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

The **external-gated** parent-directory instruction read is keyed on the same
out-of-project consent (`allowOutsideProject`), which today the `<runtime>:user`
grant provides; the M8 scope taxonomy assigns it its final scope. It is listed
in the consent prompt under **External references**.

The consent prompt's location groups are derived from the same adapter path
constants discovery uses, and a per-adapter test asserts the groups cover every
constant (roadmap S2), so this inventory and the prompt cannot drift apart
silently.

## Extending this inventory

A new adapter adds its read paths to a new section here, marked with the same
classification, as part of its mandatory pre-merge security review. The M8
choke-point test is parameterised by this inventory, so "no inventoried path is
reachable without a grant covering it" continues to hold for adapters that did
not exist when the test was written.
