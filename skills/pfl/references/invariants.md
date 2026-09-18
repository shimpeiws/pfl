# Invariants

These are guarantees the implementation is expected to uphold. A change that
breaks one is a defect, not a tradeoff.

## Read-only

`pfl` never modifies discovered harness files. No file is created, deleted,
or written inside the inspected project.

## No execution

`pfl` never executes the runtime, discovered tools, skills, hooks, scripts,
or MCP servers. No `child_process`, `eval`, `new Function`, `node:vm`, or
dynamic `import()`.

## Static first

Do not execute the runtime in order to inspect it. Reconstruction is from
files, runtime configuration, scope rules, precedence, and known runtime
semantics only.

## No symlink traversal

A symlink at any component under a scope base is recorded as
`status: "skipped", reason: "symlink-not-followed"` but never followed. The
scope base itself (home/root prefix) may be resolved as a prefix.

## No hardlink escape

A regular file with `nlink > 1` is refused. This prevents content from
escaping its intended scope via a hardlink.

## Consent boundary

Project-local discovery is implicit. Reading anything outside the project —
the user harness (`~/.claude`, `~/.codex`) and installation/version metadata —
requires explicit consent, per runtime + scope. Without the user scope,
`pfl` fails closed with exit 5 rather than assuming consent.

Persistent grants are stored per runtime + scope in `~/.pfl/permissions.json`.

## Deny-by-default persistence

Persist existence, structure, relationships, safe metadata, and digests only.
Never persist raw instructions, memory content, secrets, auth headers, tokens,
passwords, environment values, or arbitrary command arguments.

## Safe-metadata allowlist

Each adapter explicitly defines which metadata fields may be persisted.
Unknown fields are not persisted automatically.

## Best effort, never silently incomplete

Unreadable, unsupported, skipped, or unknown elements are recorded (not
ignored) and do not abort the inspection. A run that skipped every element
against a resource limit is `ok: true` with `completeness: "partial"`.

## Immutable snapshots

Existing snapshot ids are never overwritten. Observation events are
distinguished from harness state.

## Resource ceilings

The `src/limits.ts` constants bound bytes, entries, depth, artifact size,
and parse size. Non-regular files are never opened.

## Fail closed

Unknown states (unsupported schema, no consent, missing grant) refuse rather
than guess.

## Snapshots stored outside the project

`~/.pfl/` holds all persisted state. `pfl` never writes inside the inspected
repository.
