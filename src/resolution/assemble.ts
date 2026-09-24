import type { Diagnostic } from '../core/diagnostics.js';
import {
  generateResolvedSnapshotId,
  type ElementId,
  type ResolvedSnapshotId,
} from '../core/ids.js';
import type { ObservedSnapshot } from '../core/observed.js';
import type { Relation, ResolvedElement, ResolvedSnapshot } from '../core/resolved.js';
import { redactDiagnostic, type RedactionContext } from '../redact/output.js';
import { harnessContentDigest, resolvedSnapshotDigest } from '../snapshot/digest.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../snapshot/serialization.js';
import { deepFreeze } from '../util/freeze.js';

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
export const RESOLUTION_SEMANTICS_VERSION = '2';

export interface ResolvedSnapshotInput {
  /** The observed snapshot this resolution is derived from (design doc §15). */
  observed: ObservedSnapshot;
  elements: readonly ResolvedElement[];
  /** Explicit, statically resolvable edges (design doc §14). */
  relations?: readonly Relation[];
  diagnostics?: readonly Diagnostic[];
  /** Home directory for persistence redaction of diagnostics; empty means none. */
  home?: string;
  /**
   * The compatibility verdict to derive confidence from. An adapter passes the
   * position its resolution semantics selected for the detected version
   * (design doc §17), so confidence reflects the version itself rather than a
   * cached label. Defaults to the observed adapter identity.
   */
  runtimeCompatibility?: 'verified' | 'unverified';
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
  const ctx: RedactionContext = { home: input.home ?? '' };
  const diagnostics = (input.diagnostics ?? []).map((diagnostic) =>
    redactDiagnostic(diagnostic, 'persistence', ctx),
  );

  const compatibility = input.runtimeCompatibility ?? observed.adapter.runtimeCompatibility;
  const confidence: ResolvedSnapshot['resolution']['confidence'] =
    compatibility === 'verified' ? 'verified' : 'unverified-runtime-version';
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

  // Snapshots are immutable (design doc §15), so the resolved snapshot is
  // frozen deeply, exactly as the observed one is: a caller that later mutates
  // an element it handed in cannot desynchronize the elements from the
  // digests computed here.
  return deepFreeze({
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
  });
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
  const byId = new Map(elements.map((element) => [element.id, element] as const));
  const groups = new Map<string, ElementId[]>();
  for (const element of observed.elements) {
    const resolved = byId.get(element.id);
    // Only an element in force actually combines: an unresolved, unknown, or
    // shadowed one (e.g. a marketplace catalog clone, #176) is not applicable,
    // so an edge claiming it accumulates would be wrong.
    if (
      (resolved?.status !== 'effective' && resolved?.status !== 'conditional') ||
      resolved.resolution.strategy !== 'accumulate'
    )
      continue;
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
