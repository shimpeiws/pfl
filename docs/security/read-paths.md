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

### `runtime/external-install.ts`

Detection of installs the runtime's own installer does not manage (M7 Phase 6,
issue #76). M7 Phase 6 adds this shared scanner; both adapters call it with the
already-consented home and `PATH`.

| Read                                                                 | Guard                                                                                                                                                                          | Classification |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| `lstat` + `readdir` of each bin dir (`<prefix>/bin`, `PATH` entries) | `readDirectoryNames('/', dir)`: every component from the filesystem root is checked, so a symlinked leaf, PATH entry, or ancestor yields `[]`; leaf entries are never followed | install-scope  |
| `readFile` `<prefix>/lib/node_modules/<pkg>/package.json`            | `readTextFileGuarded(…, '/')`: every component from the root checked (symlink / hardlink / non-regular refused); size bounded by `MAX_PARSE_BYTES`                             | install-scope  |
| `lstat` + `readdir` of `<prefix>/Cellar/<formula>`                   | `readDirectoryNames('/', …)`: same ancestor guard                                                                                                                              | install-scope  |

The binary is detected by its name in the listing, never opened or executed, so
a symlinked launcher (`~/.local/bin/claude -> …`) counts as present without being
resolved. Prefixes are the fixed home-relative `EXTERNAL_PREFIXES` plus
`dirname` of every absolute `PATH` entry named `bin`. A PATH entry has no scope
root, so the guard walks from the filesystem root rather than from a scope base:
a symlinked `PATH` entry or a symlinked ancestor of one is skipped, not traversed.
Versions read here are reconciled with the installer-managed ones by
`runtime/version-sources.ts`, which reads no files. On macOS the root walk also
refuses paths under `/var`, because `/var` itself is a symlink; that is the
fail-closed behavior the invariant asks for, and a canonical home (`/Users/…`)
is unaffected.

### `runtime/claude-code`

| Location       | Read                                                        | Guard                                                                                                                            | Classification                |
| -------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `detect.ts`    | `lstat` of `~/.local/share/claude`, `~/.local/bin/claude`   | ancestor guard (base: home)                                                                                                      | install-scope                 |
| `detect.ts`    | `lstat` + `readdir` of `~/.local/share/claude/versions`     | ancestor guard (base: home)                                                                                                      | install-scope                 |
| `detect.ts`    | `readFile` `~/.claude/.last-update-result.json`             | `readTextFileGuarded` (leaf guard)                                                                                               | install-scope                 |
| `detect.ts`    | bin dirs, `PATH` entries, npm/Homebrew prefixes             | `readExternalInstall` (see `runtime/external-install.ts`); consent-gated                                                         | install-scope                 |
| `discovery.ts` | walk `<root>/**` for `CLAUDE.md` / `CLAUDE.local.md`        | walk guards; `selectFile` reads only those names, excluding the project config directory by path; `.git` / `node_modules` pruned | project-implicit              |
| `discovery.ts` | walk `.claude/**` and `~/.claude/<dirs>/**`                 | walk guards                                                                                                                      | project-implicit / user-scope |
| `discovery.ts` | `readFile` `settings.json`, `settings.local.json`           | `readTextFileGuarded` + scope base                                                                                               | project-implicit / user-scope |
| `discovery.ts` | `readFile` parent-directory `CLAUDE.md` / `CLAUDE.local.md` | `inspectFileTarget(dir, …)`; consent-gated; `MAX_ANCESTOR_DIRS`                                                                  | **external-gated**            |
| `discovery.ts` | `readFile` `MANAGED_CONFIG_DIR/{CLAUDE.md,settings.json}`   | `inspectFileTarget` / `readTextFileGuarded` (base: managed dir); consent-gated                                                   | **external-gated**            |
| `discovery.ts` | `readFile` `.mcp.json`                                      | `readTextFileGuarded` + `inspectFileTarget(root, …)`                                                                             | project-implicit              |
| `discovery.ts` | `readFile` `~/.claude.json`                                 | `readTextFileGuarded` (base: home)                                                                                               | user-scope                    |

M7 Phase 5 extends the Claude Code adapter (issues #69, #70, #71) with no new
unguarded read. The project instruction read becomes one subtree walk over
`<root>/**` that selects only `CLAUDE.md` / `CLAUDE.local.md`, prunes `.git` and
`node_modules`, and excludes the project config directory by path (so a
`CLAUDE.md` under `.claude/` stays the `.claude/**` walk's element and no id
collides). It is project-implicit. `CLAUDE.md` / `CLAUDE.local.md` are also read
from the project's parent directories, one directory at a time up to
`MAX_ANCESTOR_DIRS` (16): that is **external-gated**, refused without
out-of-project consent, displayed as `../CLAUDE.md`, and never follows a symlink
(`inspectFileTarget` refuses one at the leaf). The **managed** scope
(`MANAGED_CONFIG_DIR`, `/Library/Application Support/ClaudeCode/CLAUDE.md` and
`settings.json`) is a system-wide location, so it is the same class of
out-of-project read and is gated on the same consent. The default read is
macOS-only (`process.platform === 'darwin'`); discovery takes the managed base as
a parameter, so a test injects a temp directory and `/Library` is never touched.
`.mcp.json` moves from a digest-only read to the same guarded
`readTextFileGuarded` the other MCP sources use, and only the `mcpServers` key
names leave the read — a server command, argument, or environment value is never
persisted. The `settings.json` read is unchanged, but it now records
`permissions.defaultMode` as an `approval-policy` element and hook matcher
strings; hook commands, types, and timeouts are not persisted.

### `runtime/codex`

| Location       | Read                                                               | Guard                                                                                                                            | Classification                |
| -------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `detect.ts`    | `lstat` + `readdir` of `~/.codex/packages/standalone/releases`     | ancestor guard (base: `~/.codex`)                                                                                                | install-scope                 |
| `detect.ts`    | `lstat` of `~/.codex/packages/standalone/releases`, `…/standalone` | ancestor guard (base: `~/.codex`)                                                                                                | install-scope                 |
| `detect.ts`    | bin dirs, `PATH` entries, npm/Homebrew prefixes                    | `readExternalInstall` (see `runtime/external-install.ts`); consent-gated                                                         | install-scope                 |
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

M7 Phase 4 adds **no new read path**. `~/.codex/rules/**` is already inside the
walked `~/.codex/<element-dirs>/**` area recorded above, so a `.rules` file is
read by the same guarded walk. The walk's `describeFile` now derives
`{ allowCount, denyCount }` from the bytes it already read to hash, and only
those counts leave the walk — a rule pattern, command, or argument is never
persisted. The `config.toml` read is unchanged: the same single guarded
`readFile` now also records `model_context_window`,
`model_max_output_tokens`, and `model_auto_compact_token_limit` as integers.
Project-scoped skills are unchanged; `dependencies` frontmatter is read from the
same skill files and stored only as redacted, allowlisted names.

M7 Phase 6 (issues #76) adds the non-installer detection reads listed in the
`detect.ts` row above, all **install-scope** and all behind the same consent gate
as the installer-managed ones: the entries of each bin directory (the adapter's
fixed home-relative prefixes, plus every absolute `PATH` entry), the npm
`package.json` under a derived prefix, and the Homebrew `Cellar` version
directory names. A binary is detected by its listing name, never opened or
executed; a symlinked launcher is present but unresolved, and a symlinked `PATH`
entry is skipped rather than traversed. The reads are shared with Claude Code
through `runtime/external-install.ts`, so they appear once there rather than
twice here. The consent prompt's "Installation and version metadata" group now
lists these locations (roadmap S2), and a per-adapter equality test pins it.

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

M8 (`listProjectIds`) adds a `readdir` of `~/.pfl/projects` and an `lstat` of
each entry, to find histories the index no longer references. A name that is not
a safe segment is skipped, and a symlinked project directory is not a directory
under `lstat`, so it is never followed or reported.

### `snapshot/project-index.ts`

| Read                           | Guard                                                     | Classification |
| ------------------------------ | --------------------------------------------------------- | -------------- |
| `readFile` `~/.pfl/index.json` | `readTextFileGuarded` (base: `~/.pfl`); modes re-asserted | store          |
| `lstat` a project directory    | leaf-only; a symlink is not a directory                   | store          |
| `lstat` `projects/<id>/latest` | leaf-only (mtime comparison; symlink not followed)        | store          |

The index is **store metadata, not a snapshot**: mutable by design, its own
version, outside `SNAPSHOT_SCHEMA_VERSION`. It is written atomically (temp +
`rename`, modes re-asserted) like the `latest` pointer. It maps a canonical
project root to the project id its snapshots live under, so a remote change does
not move a history and a v0.1 history is adopted rather than abandoned (#86).

## Correspondence to consent scopes

M8 freezes `--allow-scope <runtime>:<scope>` (implemented in #81). The scope
names map onto this inventory:

- `<runtime>:user` — every **user-scope** row above for that runtime, plus the
  **external-gated** rows (parent-directory instructions) and the **managed**
  scope, which are the same class of out-of-project read.
- `<runtime>:install` — every **install-scope** row above for that runtime.

The mapping is enforced in one place, `src/discovery/gate.ts`, which both
adapters use; `src/runtime/*/consent.ts` groups the prompt locations by the same
scope, and the prompt-alignment test asserts each scope covers its constants.

External `.git` references are not a scope of their own: a `.git` file's
`gitdir:` outside the root is authorised by `<runtime>:user`, never by `install`
alone. Project-local reads (**project-implicit**, **store**, **implicit-git**)
need no grant.

The **external-gated** parent-directory instruction read and the **managed**
scope read (Claude Code's `/Library/Application Support/ClaudeCode`) are
authorised by `<runtime>:user` (#81), alongside the user harness. Both are listed
in the user scope's prompt group.

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
