# Security review — caller-asserted observation provenance (`--cell-id`) (#212)

- Date: 2026-09-28
- Reviewer: Devin (agent), against the `milestone-11-agent` diff
- Trigger: changes under `src/discovery/**` (`src/discovery/assemble.ts`) and
  `src/snapshot/store.ts`, both trust-boundary paths
- Result: two findings remediated in the same pull request (a stored
  `provenance` record now requires a `cellId`, and a stored `cellId` is held
  to the same bound the CLI enforced); one reported finding dismissed with
  evidence (a trailing newline does not pass `CELL_ID_PATTERN`)

## Scope and rationale

`pfl inspect --cell-id <id>` lets the caller record which yuurei cell it
asserts the inspection ran inside (#212). The value lands on the observed
snapshot as `provenance`, persisted verbatim and echoed by `inspect` (text
and JSON) and `export`; the schema bumps 1 → 2 so an older reader refuses
rather than silently dropping the field.

The value is caller input, not harness content — no adapter reads it and it
never feeds discovery. The trust questions are therefore about persistence
and display, not about a new read path: can an out-of-bounds value reach a
persisted artifact or a document, and can a stored artifact carry a value the
write path refused?

`inspect` validates the flag at the CLI boundary against `CELL_ID_PATTERN`
(`/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`), moved into `src/core/observed.ts`
so the write path and the read path share one bound. The charset excludes
whitespace, quotes, and separators, so the value is printable in a terminal
line and in JSON without escaping, and it cannot be a path (`/` is excluded).
Provenance attaches after `assembleObservedSnapshot` applies persistence
redaction and does not re-enter `digests.observed` — it is an assertion about
the observation context, never an observed fact, and never a substitute for
`snapshotId`.

The first pass of the read-path validator accepted a bare string: `cellId`
was optional inside a present `provenance`, and unbounded. Review found both
gaps: `provenance: {}` validated and exported as `cellId: null` —
indistinguishable from absent provenance — and a stored `cellId` carrying
control characters or excess length would sail through to export. Both are
closed by holding the artifact to `CELL_ID_PATTERN` on read.

A third finding claimed a trailing newline passes `CELL_ID_PATTERN`. It does
not: without the `m` flag, `$` anchors at the end of input only, so
`CELL_ID_PATTERN.test('cell\n')` is `false`. A regression case
(`'trailing-newline\n'`) is in the reject list so the claim stays false.

## Assessment

| #   | Question                                                       | Answer                                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Can an out-of-bounds `--cell-id` reach the store?              | No. `parseCellId` throws `CONFIG_ERROR` before consent, discovery, or any store write; a test asserts no artifact exists after rejection. The value is validated, not trimmed or escaped, so what validates is what persists.                                                      |
| 2   | Can a stored artifact carry a `cellId` the write path refused? | No. `isObservationProvenance` now requires `cellId` to be a string matching `CELL_ID_PATTERN`; `provenance: {}`, a non-string `cellId`, and out-of-charset or over-length strings all fail `isObservedSnapshot` and read as `invalid-snapshot`. Regression cases cover each shape. |
| 3   | Does the verbatim value need redaction?                        | It is caller-asserted metadata, not harness content, and is recorded verbatim by design. The bound keeps it printable and structural; a caller that writes a secret into its own local store is naming its own artifact, the same posture as a filename it chooses.                |
| 4   | Does provenance corrupt the observation digest or identity?    | No. `withObservationProvenance` spreads the snapshot and adds one field; `digests.observed` covers harness content only and the test pins `snapshotId`, `digests.observed`, and deep-freeze across the wrap.                                                                       |
| 5   | Does `--cell-id` open a new read path or bypass consent?       | No. It is a string flag consumed before consent resolution; it performs no filesystem access. `docs/security/read-paths.md` needs no new entry — no read was added.                                                                                                                |
| 6   | Does the schema 1 → 2 bump hold the compatibility contract?    | Yes. Writers emit only `"2"`; readers accept `"1"` and `"2"`. A schema-1 artifact has no `provenance`, which the validator treats as absent (`undefined`), and export reports `cellId: null` — unknown, not mismatch.                                                              |

## Verification

- Falsifiability: reverting `isObservationProvenance` to
  `cellId === undefined || typeof cellId === 'string'` turns the new
  malformed-provenance cases red (`{}`, embedded newline, space, >128 chars);
  removing `CELL_ID_PATTERN` from the CLI reject list fails the
  `'trailing-newline\n'` assertion. The finding suggested by review —
  `provenance: {}` exporting as `cellId: null` — now reads as
  `invalid-snapshot`.
- Full gate green: `pnpm test`, `check`, `format`, `build`,
  `typecheck:test`, `knip`.
