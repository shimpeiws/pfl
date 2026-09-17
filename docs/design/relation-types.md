# Relation types (v1.0)

- Status: frozen for v1.0
- Issue: #83
- Design references: `pfl-design-v0.1.md` §11, §14, §27, §28; `pfl-roadmap-v1.0.md` M8
- Implementation: `src/core/resolved.ts` (`RELATION_TYPES`), consumed by
  `src/snapshot/store.ts`, `src/cli/graph-model.ts`, `src/cli/show.ts`,
  `src/cli/diff.ts`

A relation is a statically provable edge between two resolved elements. Every
relation type that is declared must have a producer, a fixture, and a consumer;
a type with none of those is withdrawn rather than carried as vestigial schema.
This document is the single table the freeze rests on.

## The table

| Type              | Status    | Producer                                                                                       | Meaning                                                                                              | Fixture / test                                                                                       | `pfl graph` | `pfl diff` |
| ----------------- | --------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------- | ---------- |
| `shadows`         | produced  | `runtime/claude-code/resolve.ts` (settings precedence, local-instruction shadowing), `runtime/codex/resolve.ts` (`AGENTS.override.md`) | The `to` element is outranked by `from` at the same resolution key, so `to` is not effective.        | claude/codex fixtures (`test/e2e/cli.test.ts`), `src/runtime/*/resolve.test.ts`                       | rendered    | diffed     |
| `overrides`       | produced  | `runtime/codex/resolve.ts` (`AGENTS.override.md` replaces `AGENTS.md` in the same directory)     | The `from` element replaces the `to` element outright (not merely outranks it).                       | `src/runtime/codex/resolve.test.ts`                                                                  | rendered    | diffed     |
| `accumulates-with`| produced  | `src/resolution/assemble.ts` (`accumulate` strategy grouped by native kind)                      | Both elements combine additively; neither replaces the other.                                         | `src/resolution/assemble.test.ts`, claude/codex fixtures                                              | rendered    | diffed     |
| `contains`        | withdrawn | —                                                                                              | Containment (directory/file/plugin holding another element).                                          | —                                                                                                    | —           | —          |
| `discovered-from` | withdrawn | —                                                                                              | Provenance: an element originated in another element.                                                 | —                                                                                                    | —           | —          |
| `resolves-to`     | withdrawn | —                                                                                              | An alias/reference resolving to a target.                                                             | —                                                                                                    | —           | —          |
| `applies-to`      | withdrawn | —                                                                                              | An element applying to a target scope/capability.                                                     | —                                                                                                    | —           | —          |

`pfl graph` renders an edge for every relation a snapshot carries
(`src/cli/graph-model.ts`); `pfl diff` diffs relations by `(type, from, to)`
(`src/cli/diff.ts`). Both therefore consume every declared type generically —
the columns state that they do, not that each type has bespoke rendering.

## Why the four are withdrawn

The design doc §14 listed seven initial relation types together with the note
that "only explicit, statically resolvable edges are required initially". No
adapter has ever produced `contains`, `discovered-from`, `resolves-to`, or
`applies-to`, and each has a structural representation that already answers the
question the edge would have answered:

- **`contains`** — the provenance graph renders origin and path as a tree
  (§27). A plugin's supplied files are grouped under the `plugin` origin and
  ordered by path today; a containment edge between two elements would duplicate
  that grouping, not add a fact. No static containment edge is emitted anywhere,
  and inventing one (for example plugin → supplied skill) would introduce a
  relation the design never required.
- **`discovered-from`** — every element already carries `source.path`, the file
  it was discovered in, and `native.origin`, the scope that discovered it. The
  §27 "Where did this come from?" answer is that pair. An element-to-element
  `discovered-from` edge would be meaningful only when one element is derived
  from another within the same file, which the point-in-time snapshot does not
  represent.
- **`resolves-to`** — resolution is recorded as a property of the element
  (`resolution.strategy`, `status`, `activation`, `applicability`), not as an
  edge to another element. There is no statically resolved alias target to point
  at.
- **`applies-to`** — applicability is already the `applicability` field on the
  resolved element. A relation would carry the same value in a second place,
  and the two could disagree.

Withdrawal is not a statement that the concepts are meaningless. It is the
decision that v1.0 does not declare a schema member it cannot produce, so the
frozen relation set means exactly what a stored snapshot can contain. If a
future milestone (M4b, or the analyzer integration) finds a producer for one of
them, it is a schema addition: `SNAPSHOT_SCHEMA_VERSION` bumps, the value is
added back to `RELATION_TYPES`, and a fixture is added with it.

Section §27's example graph uses only `accumulates` and `overrides` — the two
edges it needs are among the three produced. The provenance purpose is served.

## Compatibility

The withdrawal narrows the *model*, not the schema-1 read surface, so
`SNAPSHOT_SCHEMA_VERSION` does not bump:

- Schema 1 admitted all seven values. A reader that refused four of them would
  reject an artifact the previous reader accepted, so the on-disk validator
  keeps accepting the full schema-1 set (`PERSISTED_RELATION_TYPES`). It is
  deliberately wider than `RELATION_TYPES`.
- No producer emits the four withdrawn values, so no artifact this version
  writes contains one. The reader is permissive only for files it did not write.
- No field is added, removed, or retyped; `Relation` keeps `type`, `from`, and
  `to`. The `--json` contract already treats a relation as `{type, from, to}`,
  so a consumer is unaffected. A consumer that matched one of the four values
  would have matched nothing.
- A future schema bump can drop the legacy reads and enforce `RELATION_TYPES`
  alone; that is a schema change, and it belongs to that bump, not here.

`src/snapshot/store.test.ts` pins both halves: a schema-1 artifact with a
withdrawn value still reads, and one with an unknown value is still refused.

## Enforcement

`src/core/resolved.ts` is the one declaration (`RELATION_TYPES`);
`src/snapshot/store.ts` validates against it instead of keeping a second copy,
so the declaration and the persisted-shape validator cannot drift.
`src/resolution/assemble.test.ts` asserts that resolving both the Claude and
Codex fixtures together produces at least one relation of every declared type.
A declared type with no producer therefore fails the suite, which is what makes
this withdrawal stable rather than a one-time cleanup.
