import type { Completeness, Diagnostic } from '../core/diagnostics.js';
import type {
  AdapterIdentity,
  ObservedElement,
  ObservedProject,
  ObservedRuntime,
  ObservedSnapshot,
} from '../core/observed.js';
import { generateObservedSnapshotId, type ObservedSnapshotId } from '../core/ids.js';
import { harnessContentDigest } from '../snapshot/digest.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../snapshot/serialization.js';

/**
 * Assembles the immutable ObservedSnapshot (design doc §13.1) from discovered
 * elements and the diagnostics every source produced (walker, adapter,
 * consent). The snapshot is built once and never mutated.
 *
 * Completeness is a verdict, not a score (design doc §18): `partial` when
 * anything was unreadable, unsupported, or skipped, or a warning/error
 * diagnostic was raised; `unknown` when the only gap is an element the adapter
 * could not classify; `complete` only when nothing was missing.
 */

export interface ObservedSnapshotInput {
  project: ObservedProject;
  runtime: ObservedRuntime;
  adapter: AdapterIdentity;
  elements: readonly ObservedElement[];
  /** Diagnostics from every source, in the order they should be reported. */
  diagnostics?: readonly Diagnostic[];
  /** Overridable for deterministic tests; defaults to the current time. */
  capturedAt?: string;
  /** Overridable for deterministic tests; defaults to a fresh id. */
  snapshotId?: ObservedSnapshotId;
}

export function assembleObservedSnapshot(input: ObservedSnapshotInput): ObservedSnapshot {
  const elements = [...input.elements];
  const diagnostics = [...(input.diagnostics ?? [])];
  assertReasonsPresent(elements);

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: input.snapshotId ?? generateObservedSnapshotId(),
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    project: input.project,
    runtime: input.runtime,
    adapter: input.adapter,
    elements,
    diagnostics,
    completeness: completenessOf(elements, diagnostics),
    digests: { observed: harnessContentDigest(elements) },
  };
}

export function completenessOf(
  elements: readonly ObservedElement[],
  diagnostics: readonly Diagnostic[] = [],
): Completeness {
  const incomplete =
    elements.some(
      (element) =>
        element.status === 'unreadable' ||
        element.status === 'unsupported' ||
        element.status === 'skipped',
    ) || diagnostics.some((d) => d.severity === 'warning' || d.severity === 'error');
  if (incomplete) return 'partial';
  if (elements.some((element) => element.status === 'unknown')) return 'unknown';
  return 'complete';
}

/** A non-`observed` element must say why; a missing reason is an adapter bug, not a scan gap. */
function assertReasonsPresent(elements: readonly ObservedElement[]): void {
  for (const element of elements) {
    if (element.status !== 'observed' && element.reason === undefined) {
      throw new Error(
        `observed element ${element.id} has status "${element.status}" but no reason`,
      );
    }
  }
}
