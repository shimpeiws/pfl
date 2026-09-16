import type { Diagnostic } from '../core/diagnostics.js';
import {
  generateResolvedSnapshotId,
  type ElementId,
  type ResolvedSnapshotId,
} from '../core/ids.js';
import type { ObservedSnapshot } from '../core/observed.js';
import type { Relation, ResolvedElement, ResolvedSnapshot } from '../core/resolved.js';
import { harnessContentDigest, resolvedSnapshotDigest } from '../snapshot/digest.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../snapshot/serialization.js';

/**
 * Assembles the immutable ResolvedSnapshot (design doc §13.3, §15). A resolved
 * snapshot references its observed snapshot by id rather than copying mutable
 * state, and reuses `harnessContentDigest` / `resolvedSnapshotDigest` unchanged.
 *
 * `RESOLUTION_SEMANTICS_VERSION` is pinned data: increment it when the
 * derivation or relation rules change. It feeds `resolvedSnapshotDigest`, so the
 * same harness content under different semantics produces a different resolved
 * digest.
 *
 * Confidence follows the adapter's runtime-version verdict (design doc §17): an
 * unverified version downgrades confidence and attaches a visible warning, but
 * never blocks — the resolved facts are still produced best-effort.
 */
export const RESOLUTION_SEMANTICS_VERSION = '1';

export interface ResolvedSnapshotInput {
  /** The observed snapshot this resolution is derived from (design doc §15). */
  observed: ObservedSnapshot;
  elements: readonly ResolvedElement[];
  /** Explicit, statically resolvable edges (design doc §14). */
  relations?: readonly Relation[];
  diagnostics?: readonly Diagnostic[];
  /** Overridable for deterministic tests; defaults to a fresh id. */
  snapshotId?: ResolvedSnapshotId;
}

export function assembleResolvedSnapshot(input: ResolvedSnapshotInput): ResolvedSnapshot {
  const { observed } = input;
  const elements = [...input.elements];
  const relations = mergeRelations(
    input.relations ?? [],
    accumulatesWithRelations(observed, elements),
  );
  const diagnostics = [...(input.diagnostics ?? [])];

  const confidence: ResolvedSnapshot['resolution']['confidence'] =
    observed.adapter.runtimeCompatibility === 'verified'
      ? 'verified'
      : 'unverified-runtime-version';
  if (confidence === 'unverified-runtime-version') {
    diagnostics.push({
      severity: 'warning',
      code: 'runtime-version-unverified',
      message:
        "the runtime version is not within the adapter's verified range; resolution is best-effort",
    });
  }

  const harnessContent = harnessContentDigest(observed.elements);
  const resolvedSnapshot = resolvedSnapshotDigest({
    harnessContentDigest: harnessContent,
    runtimeId: observed.runtime.id,
    runtimeVersion: observed.runtime.version,
    semanticsVersion: RESOLUTION_SEMANTICS_VERSION,
  });

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: input.snapshotId ?? generateResolvedSnapshotId(),
    observedSnapshotId: observed.snapshotId,
    runtime: { id: observed.runtime.id, version: observed.runtime.version },
    resolution: {
      semanticsVersion: RESOLUTION_SEMANTICS_VERSION,
      confidence,
    },
    elements,
    relations,
    effectiveElementIds: elements
      .filter((element) => element.status === 'effective')
      .map((element) => element.id),
    diagnostics,
    digests: { harnessContent, resolvedSnapshot },
  };
}

function mergeRelations(explicit: readonly Relation[], derived: readonly Relation[]): Relation[] {
  const merged: Relation[] = [];
  const seen = new Set<string>();
  for (const relation of [...explicit, ...derived]) {
    const key = `${relation.type}\0${relation.from}\0${relation.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(relation);
  }
  return merged;
}

/**
 * Elements that accumulate (design doc §11) form an explicit edge per kind: the
 * layers combine rather than override. Derived from the resolved strategy and
 * the observed kind, so it stays a statically provable relation.
 */
function accumulatesWithRelations(
  observed: ObservedSnapshot,
  elements: readonly ResolvedElement[],
): Relation[] {
  const strategyById = new Map(
    elements.map((element) => [element.id, element.resolution.strategy]),
  );
  const groups = new Map<string, ElementId[]>();
  for (const element of observed.elements) {
    if (strategyById.get(element.id) !== 'accumulate') continue;
    const list = groups.get(element.native.kind) ?? [];
    list.push(element.id);
    groups.set(element.native.kind, list);
  }

  const relations: Relation[] = [];
  for (const ids of groups.values()) {
    const anchor = ids[0];
    if (anchor === undefined) continue;
    for (let index = 1; index < ids.length; index += 1) {
      const other = ids[index];
      if (other !== undefined) {
        relations.push({ type: 'accumulates-with', from: anchor, to: other });
      }
    }
  }
  return relations;
}
