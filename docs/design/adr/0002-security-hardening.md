# ADR 0002 — Security hardening decisions (M6)

- Status: accepted
- Date: 2026-09-16
- Design references: §19 (Security Model), §20 (Redaction), §18 (Completeness and Diagnostics), §16 (Project Identity)
- Roadmap: §3.2 (findings S1–S12), §5 M6

## Context

`pfl` reads untrusted harness files from cloned repositories, so the v1.0
roadmap makes security hardening the first milestone and enumerates twelve
findings (§3.2). Several acceptance criteria in M6 deliberately stop short of
implementation detail: the closed set of read paths, the numeric values behind
the resource limits, the exact symlink posture, the line between implicit and
gated project-identity reads, and how hardlinks and case-insensitive volumes are
handled. Those decisions are made here so the implementation issues can be
written against a fixed shape.

This ADR settles them. The read-path closure itself is the deliverable of
`docs/security/read-paths.md` and is referenced, not repeated, here.

## Decisions

### 1. Symlink posture: never follow, everywhere

`pfl` never reads through a symlink. This is enforced at every read path, not
only inside the walk:

- **Walked areas** (`walkHarnessPaths`): a discovered symlink is recorded as
  `status: "skipped"`, `reason: "symlink-not-followed"` and never descended or
  read (unchanged).
- **Fixed-path reads** (settings files, `~/.claude.json`, `config.toml`,
  `hooks.json`, known instruction files, snapshot artifacts): every path
  component under the read's **scope base** is `lstat`ed, not only the leaf.
  `lstat` does not follow the final component but does resolve intermediate
  ones, so checking only the leaf would read through a symlinked ancestor
  directory — a hostile project can ship `.claude` as a symlink. A symlinked
  component is recorded as skipped and nothing is opened.
- **Detection** (`detect.ts`, `util/fs.ts` helpers): install and version
  locations are `lstat`ed rather than `access`ed/`readdir`ed through a link. A
  symlinked `.../claude/versions` or `.../releases` directory is not traversed.

The **scope base** is the directory whose prefix is treated as resolution
rather than traversal: the project root for project-scope reads, the user
config directory (`~/.claude`, `~/.codex`) for user-scope reads, and `~/.pfl`
for store reads. A symlink **at** the scope base is a prefix and is allowed (a
user may keep `~/.claude` in a dotfile-managed tree); a symlink **below** it is
traversal and is refused. This is the boundary that keeps the project-scope
`.claude -> /outside` case closed without breaking a symlinked user config
directory.

`realpath` remains in use **only** to compare canonical paths for containment
(`isPathWithin`); it is never used to decide what to read. Resolving the
home/root path prefix (for example `/var` → `/private/var` on macOS, or a
`$HOME` that is itself a symlink) is not "following a symlink" for the purposes
of the consent statement — the statement describes pfl's traversal of the
harness it discovers, not the operating system's resolution of a fixed prefix.

With this decision the `✗ Follow symlinks` line in the consent prompt (§24) is
true, and the test that pins the previous wording is updated in the same change
that lands the last read-path guard.

### 2. Project identity: implicit vs gated reads (S5)

`resolveProjectContext` currently walks up for `.git`, and for a `.git` **file**
follows `gitdir:` → `commondir` → `config` in order to derive a remote URL. The
`gitdir:` target is content-derived, unconfined, and read before consent is
resolved on every command.

Decision:

- **Implicit (project-local):** locating `.git` within the project root, and
  reading a `.git` **directory**'s own `config` inside that root.
- **Gated (out-of-project):** following a `.git` file's `gitdir:` when it
  resolves outside the project root, and walking above the root to find an
  ancestor `.git`.

`resolveProjectContext(cwd, { allowExternalGit })` takes the flag and defaults
to `false` (fail closed): pre-consent it examines only `.git` at the project
root, and a `.git` file is never followed. `runInspect` resolves consent first
and passes `access.allowOutsideProject`; the runtime-agnostic read commands pass
`hasAnyUserConsent(home)`, a provisional approximation M8's scope taxonomy
replaces (recorded as accepted risk A3).

Two consequences of the gated ancestor search are accepted and stated rather
than discovered later. Pre-consent, a run from a subdirectory treats the
subdirectory as the project root, so `project.root` and any project-scoped
discovery reflect the subdirectory rather than the repository root. And a
snapshot written under a path-derived id while unconsented is not found by the
read commands once a grant switches them to the remote-derived id until M8's
root index reclaims it.

Before consent is resolved, a linked worktree therefore has no git-derived
identity and `projectId` falls back to the canonical path. On a resolved run
that later derives a remote, a project **must not** be stranded under its
path-derived id. Reclamation is solved by the store's root index, which the
roadmap assigns to M8; M6 states the transition and leaves the index itself to
M8 (`docs/design/pfl-roadmap-v1.0.md` §5, M8). Nothing is entered in the
accepted-risk register for S5.

### 3. Hardlinks: skip regular files with `nlink > 1` (S3)

A hardlinked file defeats tree containment because its inode is reachable from
outside the walked root. A **regular file** whose `lstat().nlink > 1` is
recorded as `status: "skipped"` with reason `hardlink-not-followed`, and is not
read — both in `walkHarnessPaths` and at every fixed-path read
(`readTextFileGuarded`, `addKnownFile`), so the walk and the direct setting /
config reads agree.

Directories are **not** skipped on `nlink`: a directory's link count is
`2 + number of subdirectories`, so `nlink > 1` is normal and would skip nearly
every directory. Hardlinking a directory is not possible on POSIX.

### 4. Resource limits (S7)

Five quantities are limited. The values are named constants in v1.0, not
user-configurable, and are proposed here as the input to this milestone's
security review:

| Constant | Quantity | Initial value | Rationale |
|---|---|---|---|
| `MAX_FILE_BYTES` | bytes read per file | 1 MiB (1 048 576) | harness config/skill files are small text; 1 MiB is generous |
| `MAX_WALK_ENTRIES` | entries examined per `walkHarnessPaths` call (repeats across subpaths included) | 10 000 | bounds fan-out on a hostile tree without excluding a large legitimate harness |
| `MAX_WALK_DEPTH` | directory recursion depth | 32 | deep nesting is not a harness shape |
| `MAX_ARTIFACT_BYTES` | snapshot artifact read size | 16 MiB | a 10 000-element snapshot is single-digit MiB in canonical JSON |
| `MAX_PARSE_BYTES` | JSON / TOML parse input size | 1 MiB (= `MAX_FILE_BYTES`) | parsing is bounded by what a file read may return |

Semantics:

- A **per-file** limit (`MAX_FILE_BYTES`, `MAX_PARSE_BYTES`,
  `MAX_ARTIFACT_BYTES`) marks the affected element `skipped` with reason
  `limit-exceeded` and a **stable diagnostic code** that names which limit was
  hit and its value, and sets `completeness: "partial"`. A **tree-level**
  ceiling (`MAX_WALK_ENTRIES`, `MAX_WALK_DEPTH`) has no single element to mark:
  it emits the same naming diagnostic, stops the walk there, and sets
  `completeness: "partial"` through that diagnostic. No limit aborts the run
  (best-effort invariant).
- Non-regular files (FIFO, socket, device) are identified from the `lstat` mode
  already fetched and are **never opened**; they are recorded as skipped. This
  also removes the indefinite hang a FIFO at a fixed settings/config path would
  otherwise cause.
- Tests reference the constants rather than restating numbers, so changing a
  limit moves the hostile-input corpus with it; changing a value requires a
  security review under §3.3.

### 5. Path containment (S12)

`isPathWithin` composes its comparison with the path module rather than a
hardcoded `/`, so it is correct for the platform's separator. Case is not
settled by "use platform semantics" — Node does not report whether a volume is
case-insensitive. The comparison relies on the `realpath` results the OS returns
for both sides; case-insensitive behaviour is verified on a case-insensitive
volume (the macOS runner added in M10) rather than asserted. POSIX-only support
is documented in M10; this decision is about correctness on a supported platform,
not Windows.

### 6. Persistence and display treatment (S6, S8)

Every field that leaves the process passes through the allowlist, the redaction
layer, or both. Two project fields carry a stated treatment rather than an
exemption:

- `project.root` is persisted with the home prefix replaced by `~`, so it
  carries a path shape without the account name.
- `project.remote` passes the URL-credential redaction rule.

Both treatments are declared in the schema, so the property test ("every
persisted or displayed field passes through the allowlist, the redaction layer,
or both") has something to assert against. `source.path` and `diagnostics`
(message and path, including the raw `Error.message` the store embeds) are
redacted on both persistence and display.

The mechanism has two choke points, so the tiers are wired rather than defined
and unused:

- **Persistence** (`assembleObservedSnapshot`): the project root, every element
  source path, and every diagnostic pass through `redact/output.ts` at the
  `persistence` level before the snapshot is frozen and digested. This is the
  one point every adapter funnels through, and it covers every read command
  because they read stored snapshots.
- **Display / export** (`redactingLogger`): the CLI wraps its logger per command
  at `display` (terminal) or `export` (`--json`), redacting each message and any
  string `path` in structured data. This covers text produced at read time —
  store diagnostics and the error path in `index.ts` — that was never persisted.

Paths and free text are treated differently on purpose: a path gets the home
directory (raw and `/`→`-` encoded) replaced by `~` plus the token/secret rules,
but **not** the high-entropy heuristic, which would redact a legitimate long
path segment such as an encoded project directory. Free text gets the full
common policy at the channel's level. Structural fields (ids, digests, counts)
are never passed through redaction.

Three details the review tightened:

- The rules are the **union of the common policy and every runtime's**
  (`src/redact/rules.ts`), so a runtime-specific credential shape (`sk-ant-…`,
  `sess-…`) is masked in paths and diagnostics, not only in adapter metadata.
  Applying another runtime's rules can only over-mask, which is safe.
- The home replacement is **boundary-aware**: it matches the home only when a
  path separator or the end of string follows, so `/Users/alice2` is not
  mistaken for home `/Users/alice`.
- `ResolvedSnapshot` diagnostics are redacted at persistence too, so the
  guarantee holds for both snapshots even though no adapter passes diagnostics
  to resolution today.

### 7. Kind of a skipped settings/config element

A settings, `config.toml`, or `hooks.json` file that is a symlink, a hardlink,
non-regular, or over a limit is recorded as a skipped element. Because the file
was not read, its contents cannot select a kind. The element carries the kind of
the file role (`"settings"` for Claude Code settings files, `"config"` /
`"hooks"` for Codex) and `status: "skipped"` with the appropriate reason; the
classifier records it as `unknown`. This keeps the element present and visible
(the point of S1) without inventing a classification the contents cannot support.

## Consequences

- The read-path inventory in `docs/security/read-paths.md` is the closure M8
  consumes to place the consent choke point; each later adapter extends it as
  part of its own security review.
- The consent wording is derived from that inventory, so the prompt cannot
  silently fall behind the code.
- S9 (TOCTOU) and the same-uid residual of S10 remain accepted risks, recorded
  in `docs/security/accepted-risks.md`.
- The root index that reclaims path-derived histories is an M8 deliverable; M6
  fixes only the pre-consent read itself.
- Changing a limit value or reopening the symlink posture requires a security
  review under §3.3 and an update to this ADR.
