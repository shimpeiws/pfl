# ADR 0004 — Observation provenance: caller-asserted `cell_id` on the observed snapshot

- Status: accepted
- Date: 2026-09-28
- Issue: #212
- Design references: §4.2, §13.1; `schema-bump-procedure.md`;
  `pfl-json-contract.md`; `stability.md`

## Context

yuurei prepares an isolation cell before a run and wants to inspect the harness
the run will see from inside that cell, then retain the result as pre-run
evidence. For the retained export to be usable — by gatefold validating it, or
by a human comparing it to a host-side snapshot — the artifact must name which
cell its observation was claimed to be taken for, without pfl having to know or
verify the cell itself.

pfl is deliberately a static observer: it records what files exist and what a
runtime would resolve, not where it ran. The design doc's exclusion list (§4.2)
is explicit that execution context belongs to the execution-layer tool. Two
requirements pull against each other:

- The artifact needs a handle on *which observation context produced it*, or a
  yuurei cell inspection is indistinguishable from an unrelated host snapshot.
- pfl must not start asserting environment identity. It cannot verify a cell
  id; the value arrives over its own CLI from a caller it does not authenticate.

Two placements were considered:

- **Provenance on the observed snapshot.** The id is a claim about the
  observation event — "the caller tagged this inspection as running for cell X"
  — so it lives on `ObservedSnapshot`, beside `capturedAt`. Schema 1 artifacts
  have no such field; absence reads as unknown, not mismatch.
- **A separate artifact or an export-only annotation.** Either detaches the
  claim from the observation it describes: an export of a stored snapshot could
  carry a cell id the snapshot never recorded, and the store would silently
  produce artifacts that do not survive a round trip. Provenance that is not
  persisted is not provenance.

## Decisions

### 1. `ObservedSnapshot.provenance.cellId` is optional caller-asserted provenance

`pfl inspect --cell-id <id>` records the supplied value as
`provenance.cellId` on the observed snapshot, projected into `inspect`'s
`observed.cellId` and `export`'s `snapshot.cellId` — `null` when absent. The
field is attached after assembly by `withObservationProvenance`, which returns
a new frozen snapshot: `snapshotId`, `digests.observed`, and every element id
are byte-identical to the unprovenanced artifact. Provenance is metadata about
the event, not an input to identity or content digests.

### 2. The value is recorded verbatim and never certified

pfl validates and bounds the input — 1–128 characters, `[A-Za-z0-9]` start,
`[A-Za-z0-9._:-]` thereafter — and rejects anything else with `CONFIG_ERROR`
before writing. That is a safety bound (filesystem-safe, printable, bounded),
not verification: pfl does not check the id exists, was prepared, or matches
the environment it is reading. Whether a snapshot honestly names its cell is
yuurei's problem; whether two artifacts claim the same cell is gatefold's.

### 3. The persisted shape change bumps the schema to `"2"`

Per `schema-bump-procedure.md`, any addition to a persisted field is a shape
change. `SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS` keeps `"1"`, the reader accepts a
schema-1 artifact verbatim, and its absent `provenance` surfaces as
`cellId: null` — unknown, never a mismatch. The validator rejects a
`provenance` that is present but malformed (non-object, or a `cellId` that is
not a string) at every version: an optional field is not a license for
garbage.

## Consequences

- A cell-scoped inspection is distinguishable from a host snapshot in stored
  artifacts and exports, at zero cost to standalone use.
- Old artifacts keep reading, and a new artifact under an old reader fails
  loudly with `unsupported-snapshot-schema` — the designed behavior.
- Downstream consumers must not treat `cellId` as evidence of what was
  observed; it is evidence of what the caller *claimed*.
