# Security review — M7 Phase 7 (classification and findings gaps)

- Date: 2026-09-17
- Reviewer: `codex exec -s read-only` (independent model), one pass against the
  uncommitted diff; plus a maintainer self-review
- Trigger: none of the trust-boundary triggers are in the diff; the record is
  written so the required check has something to cite
- Result: no trust-boundary impact; 1 warning and 1 nit raised by the independent
  pass, the nit fixed and the warning recorded as a scoped follow-up

## What changed

Issue #77 closes the classification and findings gaps M7 left open. The
classifier gains a `fallback-instructions` row (Codex's `AGENTS.override.md`, the
highest-precedence instruction file, previously resolved to zero facets), the
declared-but-never-emitted `low` classification confidence is removed from
`ClassificationConfidence` and design doc §21, `CLASSIFIER_VERSION` advances from
`3` to `4`, and the table gains a small coverage API (`classifiedKind` and an
explicit `UNCLASSIFIED_KINDS` set) so a test can assert every kind either adapter
declares is mapped or deliberately recorded. Tests add end-to-end
`subtree-specific-instruction` coverage through both adapters' real discovery and
resolution, and a type-level assertion that `low` is gone.

## Trust-boundary check

The diff touches `src/core/interpretation.ts`, `src/classify/classifier.ts`,
`src/classify/classifier.test.ts`, both adapters' `discovery.test.ts`, and
`docs/design/pfl-design-v0.1.md`. It does **not** touch any trigger path:
`src/runtime/*/paths.ts`, `consent.ts`, `detect.ts`, `walk.ts`, `limits.ts`,
`src/util/fs.ts`, `src/redact/**`, or `src/snapshot/store.ts`. The only `paths.ts`
references are test-only imports of `KNOWN_ELEMENT_KINDS`. Classification is
recomputed from already-resolved snapshots (design doc §21) and is never a read
path, so the change is classification-only with no trust-boundary impact.

## Invariants checked

Read-only, no execution, no new read path, deny-by-default persistence
unchanged, no comments beyond the existing JSDoc, determinism of the classifier
table (roadmap §3.1 / §3.2).

## Findings and disposition

| #   | Severity | Finding                                                                                                                                                                                                                                | Disposition                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Warning  | `subtreeSpecificInstruction()` in `src/classify/findings.ts` accepts only `native.kind === 'instructions'`, so a nested `AGENTS.override.md` (`fallback-instructions`) that resolves to `directory-subtree` does not emit the finding. | **Out of scope, recorded as a follow-up.** The phase's settled decisions cover the classifier table and the type, not the finding rule's kind spelling; de-hardcoding `findings.ts` kind spellings is explicitly M9 (roadmap §5 M9: "findings.ts no longer keyed on hardcoded kind spellings"). The rule itself is proven reachable end to end for both adapters' nested `CLAUDE.md` / `AGENTS.md`. |
| 2   | Nit      | The kind-coverage test proves every declared kind is mapped but not that `classifiedKind()` returns false for unknown or inherited keys, so a regression to a non-own-key check could survive.                                         | **Fixed.** The coverage test now asserts `classifiedKind('mystery-kind')` and `classifiedKind('constructor')` are both false, which a plain `in` or `!== undefined` check would fail.                                                                                                                                                                                                               |

## Dismissed (checked and fine)

- **No new read path.** Every added file operation is confined to the test tree;
  production imports change only in `classifier.ts` and `interpretation.ts`,
  neither of which reads a file.
- **No execution or dynamic loading.** No `child_process`, `exec`, `spawn`, or
  dynamic import is introduced.
- **Persistence unchanged.** `classify()` returns the same shape; the classifier
  version is data, and nothing new reaches the store.
- **The `low` removal is schema-consistent.** The type, the design doc §21 union,
  and every table row agree; the classifier scale is high / medium / unknown. A
  type-level test fails to compile if `'low'` returns.
- **The coverage set is empty and honest.** Every kind either adapter declares
  has a deterministic mapping, so `UNCLASSIFIED_KINDS` names nothing; the test
  still fails the moment a kind is added without a row.
- **Determinism is preserved.** The new row is a static table edit, and existing
  order-independence tests remain green.

## Follow-up (out of scope for this phase)

- `src/classify/findings.ts` keys `subtree-specific-instruction` on the literal
  `instructions` kind, so `fallback-instructions` (and any future adapter's
  instruction kind) does not contribute. M9's kind-registration work removes the
  hardcoded spellings; until then, nested `AGENTS.override.md` trees are
  classified but not summarized by that finding.

## Verification

- Independently reviewed with `codex exec -s read-only`; it confirmed no
  trust-boundary path is touched, no production I/O or persistence change, and
  that the classifier table covers all declared kinds. Its two findings are
  dispositioned above. (It could not start the vitest suite because the read-only
  sandbox blocks Vite's `node_modules/.vite-temp` write; the maintainer ran the
  gate.)
- Full gate green: `test` (418 tests, 49 files), `check`, `format`, `build`,
  `typecheck:test`, `knip`.
- End-to-end through the built CLI against materialized fixtures (`inspect` then
  `report --json`): both `claude-code` and `codex` emit
  `subtree-specific-instruction` ("1 instruction(s) apply to a directory
  subtree") citing the nested instruction element; the element's interpretation
  reports `facets: ["instructions"]`, `confidence: "high"`; a Codex rules fixture
  with `allowCount >= 10` emits `broad-tool-access`.
