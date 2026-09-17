# ADR 0001 — Snapshot serialization, schema versioning, and id generation

- Status: accepted
- Date: 2026-09-15
- Issue: #3
- Design references: §13, §15, §29, §33

## Context

The design document fixes the snapshot interfaces but leaves three things open
(§33): the exact serialization format, the schema-versioning policy, and how ids
are generated. The scaffold declares five id types as bare `string` aliases with
no generator, so snapshot writing (#4) and assembly (#5) have nothing concrete
to target.

Two constraints shape the decision:

- Snapshots are immutable (design doc §15). The format must never require
  rewriting a snapshot in place.
- Persistence is deny-by-default (design doc §19). The serializer writes only
  what the model already holds; it never reaches back into the filesystem.

`canonicalJsonStringify` (`src/util/json.ts`) already produces key-sorted JSON
with code-unit ordering, and `harnessContentDigest` / `resolvedSnapshotDigest`
(`src/snapshot/digest.ts`) already digest that canonical form. The format reuses
them rather than introducing a second serializer.

## Decisions

### 1. Serialization format

One file per snapshot, containing newline-terminated canonical JSON produced by
`canonicalJsonStringify`.

- Key sorting makes the bytes independent of object insertion order, so the same
  snapshot always serializes to the same bytes on any host (code-unit order, not
  `localeCompare`).
- The trailing newline keeps the file POSIX-text friendly.
- One file per snapshot satisfies immutability: a capture writes a new file and
  never edits an existing one.

Implemented in `src/snapshot/serialization.ts` as `serializeSnapshot` /
`deserializeSnapshot`.

### 2. Schema versioning policy

`schemaVersion` is a decimal integer string (`"1"`, `"2"`, …).

- It increments when the persisted shape changes in a way an older reader cannot
  safely interpret: a field added, removed, retyped, or given new meaning.
- It does not increment for a change that is invisible on disk.
- A reader supports an explicit set of versions
  (`SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS`). An unknown version is a hard error
  (`UnsupportedSchemaVersionError`), not a best-effort read. Snapshots are
  immutable, so an unreadable snapshot is never rewritten or migrated in place.
- A newer snapshot written by a future `pfl` is therefore refused by an older
  `pfl`, rather than misread.

### 3. Id generation

- **Snapshot ids** (`obs_…`, `res_…`, `int_…`) identify an observation event,
  not harness state (design doc §15), so they are unique per capture and
  generated from 6 random bytes. They are not content-derived.
- **`ElementId`** must be stable across runs for the same element, or snapshot
  diffing (#22) reports spurious churn. It is derived deterministically from
  runtime + origin + path (`elementIdFor`), never random.
- **Branding**: the four data ids are branded so the compiler rejects passing one
  where another is expected. `RuntimeId` is branded too, with a `runtimeId()`
  constructor; adapters build their id through it instead of casting a string
  literal.

## Consequences

- `pfl snapshots` and the read commands (#4) can list and parse stored snapshots
  and must treat `UnsupportedSchemaVersionError` / `InvalidSnapshotError` as
  diagnostics, not crashes. Issue #82 fixes how, since the two read paths had
  diverged:
  - A **scan** (`listRuns`, the `snapshots` command) skips the artifact and adds
    a diagnostic naming the version found and the versions supported; the scan
    and the command succeed.
  - A **direct read** of a specific artifact (`report` / `list` / `show` /
    `graph` / `diff`, whether the id is named or `latest`) cannot produce data
    from an artifact it cannot interpret, so it fails with exit 2
    (`CONFIG_ERROR`), not 6. The failure document carries the same diagnostic in
    its `diagnostics` array, so a consumer acts on it rather than on prose, and
    the message states the version found and the versions supported. Exit 6 is
    reserved for a store that could not be read at all.
  - Both conditions are handled identically; a malformed artifact is not a
    different failure from an unsupported version.
  - The `latest` pointer is the one mutable artifact, not an immutable snapshot,
    so a corrupt or unreadable pointer remains a store failure (exit 6). It
    carries no `schemaVersion` to refuse; being unable to read it means the
    store itself could not be read.
- Any change to a persisted snapshot shape must bump `SNAPSHOT_SCHEMA_VERSION`
  and add the new value to `SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS`.
- A run writes several artifacts in turn — observed snapshot, resolved
  snapshot, interpretation — and only then replaces `latest`. Each write is
  atomic and immutable, but the run as a whole is not one transaction: a failure
  between writes leaves an artifact the pointer does not name. `latest` is the
  publish boundary, so such an artifact is not visible to a read command; it is
  an orphan for `pfl gc` to reclaim (#87), not a corruption to repair.
- Element ids are opaque (`el_<16 hex>`); humans read `source.path`, not the id.
- `ElementId` currently derives from runtime + origin + path only. If two
  distinct elements can share all three, the derivation must be extended (for
  example with the native kind) and its version called out — tracked when the
  adapters build elements (#9, #10).
