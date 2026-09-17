# Security review — M8 package surface, resolved freeze, and relation types (#89, #83)

- Date: 2026-09-18
- Reviewer: independent adversarial review (`codex exec -s read-only`) plus a
  maintainer self-review against the design invariants (design doc §19; roadmap
  §3.1, §3.2)
- Trigger: `src/snapshot/store.ts` changed (the relation validator's accepted
  set). No other trigger path is in the diff.
- Result: no trust-boundary impact found; no remediated findings, no accepted
  risks added

## What changed

Issue #89 restricts `package.json` `exports`, deep-freezes the
`ResolvedSnapshot` at assembly, and lets `diff` accept the literal `latest` and
default its second operand. Issue #83 settles the relation-type table: three
produced types stay, four unproduced types are withdrawn from the model, and the
duplicated declaration collapses to `src/core/resolved.ts`.

The only trust-boundary-relevant edit is in `src/snapshot/store.ts`: `isRelation`
now validates against `PERSISTED_RELATION_TYPES` instead of a private
`RELATION_TYPE_VALUES` copy. That set is the union of the three produced types
and the four withdrawn ones, i.e. exactly what schema 1 admitted before this
change.

## Trust-boundary check

- **Read surface unchanged.** No new filesystem read, no new path constant, no
  change to `walk.ts`, `util/fs.ts`, `limits.ts`, `redact/**`, or any adapter's
  `paths.ts`/`consent.ts`/`detect.ts`. `docs/security/read-paths.md` needs no new
  row.
- **The validator is not loosened for unknown values.** The four withdrawn values
  were already valid under schema 1; accepting them is what keeps a stored
  artifact the previous reader accepted readable. A genuinely unknown value is
  still refused, and a store test pins both directions
  (`src/snapshot/store.test.ts`).
- **No production write path changes.** No producer emits the withdrawn values,
  so no artifact this version writes can contain one. `SNAPSHOT_SCHEMA_VERSION`
  is unchanged, so no artifact's meaning moves.
- **Immutable snapshots.** `deepFreeze` is added, not removed; it makes the
  resolved snapshot harder to mutate, in the same way the observed snapshot
  already is. No write, move, or rewrite is introduced.
- **`exports` cannot widen the runtime surface.** `"exports": { "./package.json":
"./package.json" }` blocks both the bare entry and every `dist/` deep import,
  so the package exposes strictly less to an importer than it did. The `bin` is
  executed by file path and is unaffected. A test asserts the block.

## Invariants checked

Read-only; no execution or dynamic loading; no new read path; deny-by-default
persistence unchanged; snapshots immutable (strengthened); fail closed on an
unknown artifact value; the change cannot widen what leaves the process.

## Findings and disposition

None. The first independent review raised one compatibility warning — that
narrowing the relation enum under the same `SNAPSHOT_SCHEMA_VERSION` would make
this reader reject a schema-1 artifact the previous reader accepted. It was
remediated by keeping the read surface permissive (`PERSISTED_RELATION_TYPES`)
and adding the two-way store test; the schema version stays `"1"` and nothing
that was valid becomes invalid.

## Verification

- Full gate green: `test` (53 files, 449 tests), `check`, `format`, `build`,
  `typecheck:test`, `knip`.
- New tests: a schema-1 resolved artifact carrying a withdrawn relation type
  reads; an unknown value is refused; every declared relation type is produced by
  a named runtime's fixture; a nested resolved snapshot is frozen; a bare or deep
  import of the package fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- A confirmation review round could not run: the codex CLI returned a usage
  limit. The remediation is covered by the tests above.
