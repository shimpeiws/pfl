# Schema-bump procedure (v1.0)

- Status: frozen for v1.0
- Issue: #88
- Design references: `pfl-roadmap-v1.0.md` M8; `adr/0001-snapshot-serialization-and-ids.md`;
  `pfl-json-contract.md`

Two different contracts leave `pfl`, and they version differently. This document
is the procedure for changing either.

## The two contracts

- **On-disk artifacts** (`~/.pfl/`): observed snapshot, resolved snapshot,
  interpretation. Governed by `SNAPSHOT_SCHEMA_VERSION`. **Stricter rule:** any
  change to the persisted shape bumps the version, including an *addition*,
  because a reader of a stored artifact must not guess.
- **CLI `--json` documents**: governed by the rules in `pfl-json-contract.md`.
  **Looser rule:** readers ignore unknown fields; adding a field is a minor
  change, and only removing, renaming, or retyping one is major. The two are
  deliberately not unified.
- The **project index** (`~/.pfl/index.json`) is store metadata, not a snapshot.
  It carries its own `indexVersion`, outside `SNAPSHOT_SCHEMA_VERSION`.

## Is it a shape change?

A change to a persisted artifact is a shape change when it adds, removes,
retypes, or changes the meaning of a field, or **narrows or widens the accepted
set of a field's values**. An addition is a shape change on disk even though it
is minor for the CLI document.

Two things are explicitly **not** shape changes and do not bump:

- A value the model already allowed being produced for the first time.
- Removing a declared value no artifact can contain — though the accepted set is
  part of the persisted contract, so this is judged per case and recorded.

## Procedure

1. **Bump `SNAPSHOT_SCHEMA_VERSION`** in `src/snapshot/serialization.ts` to the
   next decimal integer string.
2. **Add it to `SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS`.** Never remove an older
   version from the supported list in the same change: keeping it is what lets a
   new binary read the history it is supposed to adopt.
3. **Keep the reader permissive for older versions.** A narrowed validator would
   reject an artifact an older reader accepted. The validators are version-
   independent today; the first time one must differ by version, thread the
   parsed `schemaVersion` into it rather than applying the current version's set
   to all of them.
4. **Add a read-compatibility fixture**: a stored artifact at the previous
   version, under `test/fixtures/schema/`, read by the current binary in
   `test/golden/freeze.test.ts` (the `legacy-*` fixture). A bump is proven not to
   break reading, not assumed.
5. **Refresh the golden files** under `test/golden/` for the representative
   stored snapshot (the canonical fixture bytes) and for each command's `--json`
   document, including `inspect`. A shape change is visible in review only if the
   goldens move with it.
6. **Write the change down**: update this document's history and, when the
   change is a compatibility event, an ADR.

## What it means for a user

- A newer `pfl` keeps reading an older snapshot. `origin: "recomputed"` on an
  interpretation reports that the run predates stored interpretations.
- An **older** `pfl` reading a **newer** snapshot reports an
  `unsupported-snapshot-schema` diagnostic naming the version found and the
  versions supported, and exits 2. It never guesses at a shape it does not know.
- The package version is independent of `SNAPSHOT_SCHEMA_VERSION`; see
  [`versions.md`](versions.md).
