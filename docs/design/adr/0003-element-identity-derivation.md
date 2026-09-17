# ADR 0003 — Element identity: native kind in the `ElementId` derivation

- Status: accepted
- Date: 2026-09-17
- Issue: #79
- Supersedes: the open question in ADR 0001 ("ElementId currently derives from
  runtime + origin + path only …")
- Design references: §11, §13.2, §15; Roadmap §5 (M8)

## Context

ADR 0001 fixed `ElementId` as a deterministic digest of runtime + origin + path
and recorded that if two distinct elements can share all three, the derivation
must be extended. They can: one harness file yields many elements. A Claude Code
`settings.json` yields permissions, hooks, MCP servers, output style, and
plugins; a Codex `config.toml` yields model, context, plugins, marketplaces,
hooks, and the sandbox/shell sections; a Codex `rules/default.rules` yields a
`rules` element and a separate `permissions` element.

Today those elements are told apart only by a naming convention: the display
path carries a synthetic `#fragment` (`settings.json#permissions`). Nothing
enforces the convention. An adapter that builds two elements from one file
without inventing a fragment produces two elements with the same id, and `pfl
diff` then reports churn or loses one. The failure has already occurred once: the
M7 Phase 3 security review found that a file at `.codex/skills/AGENTS.md` would
be recorded twice with the same runtime + origin + path — once as `skills` by the
skills walk, once as `instructions` by the instruction walk
(`docs/security/reviews/2026-09-17-m7-phase3-codex-agents-tree.md`, finding 2).
It was fixed there by excluding the path from the instruction walk, which removes
the symptom in that one place but leaves the derivation collision-prone.

The fragment convention is also parsed in two modules with no shared constant:
`settingsKey` in `src/classify/findings.ts` and `settingsKeyOf` in
`src/runtime/claude-code/resolve.ts`, while both adapters spell the fragments by
hand.

One property is already right and is preserved: the id derives from the
**display** path (`~/.claude/…`, project-relative), never an absolute one, so an
id does not embed the account name or a machine's file layout.

Two shapes of fix were considered:

- **Extend the identity.** Name a discriminator in `ElementIdentity` so a
  forgotten fragment cannot collapse two elements into one id. This is the
  honest description of what an element is, but it changes the id of every
  element, because the digest covers the identity.
- **Type-enforce the fragment convention.** Keep ids stable, but a type can only
  make forgetting *loud* for callers that go through the enforcing constructor —
  TypeScript cannot force two calls to a string-producing helper to differ, so
  the convention still cannot be made true, only checked.

## Decisions

### 1. The native `kind` joins the identity

`ElementIdentity` becomes `{ runtimeId, origin, path, kind }`, and `elementIdFor`
digests all four. `kind` is the element's native kind (design doc §11) — a
required, always-assigned property of every element.

This closes the realistic collision structurally: two elements built from one
file with **different kinds** can no longer share an id even if the adapter never
invents a fragment, and the `.codex/skills/AGENTS.md` case from the M7 review
could no longer have produced a duplicate id in the first place.

`kind` was chosen over a separate `fragment` field. A fragment field would have
to be optional to leave whole-file elements alone, and an optional field does
nothing in exactly the case that matters — the adapter that forgot the fragment.
`kind` needs no new path semantics, already exists on the observed element, and
is present whether or not a fragment is.

Honest limit: two elements of the **same** kind built from one file still need
distinct display paths. This is not a latent gap, because such elements need
distinct fragments for an independent reason: the fragment is the settings key
that cross-scope shadowing and the `conflicting-scope` finding group on. Codex's
`config.toml#plugins` and `config.toml#marketplaces` are both `plugin` elements
and are separated by their fragments, which they must have anyway. The identity
extension removes the fragment's *uniqueness* burden for different-kind
elements; it does not remove the fragment.

### 2. The fragment convention has one definition

`src/core/element-path.ts` owns it:

- `withFragment(filePath, key)` builds `<file>#<key>`.
- `fragmentKeyOf(displayPath)` returns the key, or `null` for a whole file.

`src/classify/findings.ts` and `src/runtime/claude-code/resolve.ts` parse through
`fragmentKeyOf` instead of splitting on `#` themselves, and both adapters build
their fragment paths through `withFragment`. The convention is still a
convention — its uniqueness is now enforced by the identity, not by the string —
but it can no longer drift between the producer and the consumers.

## Compatibility — ids are the diff key

This is a compatibility event, stated plainly.

- **Every existing element id changes**, because `kind` enters the digest. There
  is no partial stability: the digest covers the whole identity object.
- **Stored snapshots are not rewritten, migrated, or invalidated.** Element ids
  are not an index anywhere in the store: `latest` and the run summary point at
  `obs_…` / `res_…` snapshot ids, and element ids live only inside the immutable
  snapshot they were captured with. An old snapshot stays readable and diffs
  against another old snapshot exactly as before.
- **A diff across the derivation boundary is meaningless**: the same harness
  captured under the old and new derivations shares no element ids, so every
  element is reported as removed and added rather than changed.
- **A kind change at one path** across snapshots is now a removal plus an
  addition, not a one-element "change". That is the correct reading once kind is
  part of identity; the previous "change" was only observable because identity
  ignored kind.
- **Schema-version policy is out of scope.** An id derivation is not a change to
  the persisted *shape* ADR 0001's rule governs, and the policy itself is the
  sibling issue "Reconcile schema-version failure handling with ADR 0001". This
  ADR states the consequence; it does not decide whether the id change needs a
  signal of its own.
- **Timing.** M8 freezes the identity scheme, so this is the last point at which
  the derivation can change without stranding a released history. v1.0 has not
  shipped; the snapshots affected are development and test captures.

The display-path basis is preserved, so ids remain independent of the home
directory's absolute location; a discovery test plants identical content under
two different absolute bases and asserts the ids match. The user-memory display
path embeds Claude Code's encoded project root by the runtime's own layout, so
those ids are stable per project and runtime; this decision does not change that.

## Consequences

- Every element-builder call passes the element's kind; passing a bare path is
  now a type error at the `ElementIdentity` boundary.
- The collision fixture is a unit test in `src/core/ids.test.ts`: two elements
  from one file that deliberately share runtime, origin, and path, differing only
  in kind, assert distinct ids. The independence test lives in
  `src/runtime/claude-code/discovery.test.ts`.
- ADR 0001 keeps its text; its open question is superseded here.
- A future change to any identity component (runtime, origin, path, kind) is
  again a compatibility event of the size described above.

## Alternatives considered

- **Type-enforce the convention instead.** Rejected: it keeps stored ids stable
  but cannot make the convention true, only make forgetting loud for callers that
  use the enforcing constructor — and it leaves the collision structurally
  possible, which is the defect.
- **A separate `fragment` field instead of `kind`.** Rejected: optional to
  preserve whole-file elements, and an optional field does not help the adapter
  that forgot the fragment, which is the case the decision exists for.
- **Assert id uniqueness at assembly.** Rejected: runtime detection makes a
  forgotten fragment loud rather than impossible, and turns a discovery defect
  into a failed capture, against the best-effort invariant.
