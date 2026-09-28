# Verification contract cards

These cards extract high-value semantic propositions from pfl's existing
design, security policy, and yuurei integration. They are not a replacement for
those normative documents.

The review unit is a **verification proposition × observation point**, not a
test file.

## VC-P-01 — Inspection is static

**Verification proposition**

pfl describes the harness visible to the target runtime without executing the
agent or discovered hooks, tools, skills, or MCP servers.

**Owner**

pfl product semantics.

**Source**

README and `docs/design/pfl-design-v0.1.md`.

**Required evidence**

- discovered elements come from bounded static inputs;
- runtime / tool execution is not required to produce an inspection;
- unsupported or opaque behavior remains explicit.

**Allowed variation**

Adapter internals and parsing strategy.

**Forbidden**

- executing discovered content to decide whether it exists or is effective;
- presenting runtime behavior as statically observed fact.

**Observation points**

- unit: adapter and resolver behavior;
- boundary: filesystem/config discovery;
- system: `pfl inspect` against real supported runtime configuration.

**Failure routing**

Adapter / resolver when semantics are wrong; input boundary when data was read
incorrectly.

---

## VC-P-02 — Incompleteness remains observable

**Verification proposition**

Unreadable, skipped, unsupported, opaque, missing, or failed observation must
not silently become a complete snapshot.

**Owner**

pfl observation semantics.

**Source**

Design principle "Best effort, never silently incomplete"; README machine
output contract; yuurei integration issue #211.

**Required evidence**

- completeness state;
- diagnostics;
- scope / inspectability information where relevant;
- durable export preserves the same uncertainty.

**Allowed variation**

Diagnostic wording and adapter-specific reasons.

**Forbidden**

- partial -> complete;
- unavailable scope -> empty successful scope;
- opaque -> absent;
- observation failure -> "no configuration change".

**Observation points**

- unit: snapshot/export normalization;
- boundary: denied / unsupported / unreadable scopes;
- system: prepared-cell inspection used by yuurei.

**Failure routing**

Collector / resolver / export normalization, or upstream caller if the
observation itself was unavailable.

---

## VC-P-03 — Provenance assertions are not observations

**Verification proposition**

Caller-supplied provenance such as `cell_id` or source-project identity is
retained as an assertion and must not be presented as something pfl
independently verified.

**Owner**

pfl snapshot/export provenance contract.

**Source**

README `cellId` semantics; issues #211 and #217.

**Required evidence**

- caller assertion stored separately from observed cell-local project facts;
- snapshot ids remain distinct;
- provenance survives inspect -> snapshot -> export;
- missing assertion stays unknown.

**Allowed variation**

Additive versioned field shape.

**Forbidden**

- caller assertion rewritten as an observed fact;
- source identity collapsed into cell-local path identity;
- missing identity reconstructed from host Git/config;
- `cell_id` substituted for snapshot identity.

**Observation points**

- unit: inspect/snapshot/export round trip;
- integration: yuurei-prepared cell hand-off;
- system: two real cells from one source project retain equal source identity
  but distinct cell/snapshot identities.

**Failure routing**

CLI input / snapshot persistence / export serialization.

---

## VC-P-04 — Effective means statically potentially effective

**Verification proposition**

pfl's resolved/effective state means that an element can affect the agent under
the reconstructed runtime semantics; it does not prove the runtime actually
used it.

**Owner**

pfl resolution semantics.

**Source**

README and design document.

**Required evidence**

- observed layer;
- resolved layer and reason;
- runtime/version/resolution semantics provenance;
- opaque/conditional state where applicability cannot be established.

**Allowed variation**

Runtime-native resolution algorithms and future adapter implementation.

**Forbidden**

- "effective" -> "executed";
- static presence -> causal effect on an outcome;
- missing resolved layer -> ineffective.

**Observation points**

- unit/property: resolver rules;
- integration: native config precedence and scope interactions;
- system: inspect real supported runtime layouts.

**Failure routing**

Runtime adapter / resolver / interpretation layer.

---

## VC-P-05 — Observation is bounded and sanitized

**Verification proposition**

pfl may inspect only within its documented consent and resource boundaries, and
persisted / emitted data must pass the documented sanitization rules.

**Owner**

pfl security contract.

**Source**

README security section, `SECURITY.md`, and `docs/security/`.

**Required evidence**

- out-of-project reads require consent;
- symlinks/hardlinks are not followed;
- path / size / resource ceilings are enforced;
- secrets/raw sensitive content do not bypass the output policy.

**Allowed variation**

Internal walkers, parsers, and storage layout.

**Forbidden**

- implicit host-scope expansion;
- following unsafe links;
- unbounded traversal/parse;
- secret-bearing raw input copied into durable output without the allowed
  sanitization path.

**Observation points**

- unit: path/resource/sanitization helpers;
- integration: real filesystem boundaries;
- CI: Linux plus macOS behavior, including platform-specific managed scope.

**Failure routing**

Input boundary / security policy / persistence layer.

---

## Initial inventory

- **VC-P-01:** adapters and resolution internally, filesystem/config discovery
  at the boundary, and real `inspect` flows at the system boundary. Coverage
  is strong.
- **VC-P-02:** snapshot/export semantics internally, denied and opaque scopes at
  the boundary, and prepared-cell inspection at the system boundary. Semantics
  are strong and the concrete evidence is indexed below.
- **VC-P-03:** provenance model internally and yuurei hand-off at the boundary.
  The real two-cell system path is active work in #217.
- **VC-P-04:** resolver semantics internally, precedence/scope interactions at
  the boundary, and real runtime layouts at the system boundary. Coverage is
  strong.
- **VC-P-05:** security helpers internally, filesystem boundaries in
  integration, and Linux/macOS CI at the system boundary. Coverage is strong.

## Review rule

For each test or check, ask:

> Which semantic proposition does this evidence support, and would the check
> still pass for a different correct implementation?

If not, treat it as implementation-maintenance evidence unless the internal
shape is itself part of the contract. Unknown and incomplete states must survive
all the way to export so downstream consumers can decide what they can and
cannot conclude.

## Concrete evidence inventory

A first pass over the current suite shows that pfl already has strong semantic
coverage. The missing piece was primarily an index from meaning to evidence.

- **VC-P-01:** `test/integration/security-invariants.test.ts` contains an
  explicit no-execution guard. Runtime discovery/resolver tests and
  `test/e2e/cli.test.ts` cover the lower and outer boundaries. Strong.
- **VC-P-02:** `src/cli/export.test.ts` explicitly surfaces partial
  completeness instead of hiding it.
  `test/integration/security-invariants.test.ts` records unsupported and
  unreadable entries as partial, and E2E reports why a snapshot is partial.
  Strong across normalization, filesystem boundary, and CLI.
- **VC-P-03:** `src/cli/inspect.test.ts` records caller-supplied `cell_id` as
  observation provenance and leaves standalone runs without it.
  `src/cli/export.test.ts` preserves unknown provenance rather than a
  mismatch, and E2E round-trips `--cell-id`. Cell provenance is strong; the
  source-project provenance half remains #217.
- **VC-P-04:** `src/resolution/resolver.test.ts`, runtime-specific
  `resolve.test.ts` suites, and export behavior preserve unresolved null
  layers rather than converting them into negative facts. Strong.
- **VC-P-05:** `test/integration/security-invariants.test.ts`,
  `test/integration/consent-choke-point.test.ts`, runtime consent tests,
  redaction tests, and Linux/macOS CI provide both negative-security and real
  filesystem evidence. Strong.

### Gaps / active work

Only one material gap was found in this five-card set:

- **#217 — source-project provenance distinct from cell-local project identity.**
  Current `cell_id` provenance already behaves correctly. What is missing is
  the stable caller-declared source identity required for two independently
  prepared cells to be comparable without pretending their temporary workspace
  paths are the same observed project.

No additional issue is warranted for VC-P-01, VC-P-02, VC-P-04, or VC-P-05
based on this pass.

### Candidate de-emphasis during future test cleanup

A useful distinction emerged inside the resolver / adapter suites:

- tests that protect precedence, applicability, opacity, or completeness are
  semantic evidence;
- tests that only mirror parser decomposition or internal adapter call shape are
  maintenance evidence.

Both can be kept, but only the former should drive confidence that a
verification proposition is protected.
