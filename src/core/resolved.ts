import type { Diagnostic } from './diagnostics.js';
import type { ElementId, ObservedSnapshotId, ResolvedSnapshotId, RuntimeId } from './ids.js';

/**
 * Resolved Facts: facts produced by applying deterministic runtime semantics
 * to the Observed Facts (design doc §7.2, §11).
 */

/** Design doc §11, Activation. */
export type Activation = 'always' | 'conditional' | 'on-demand' | 'event-driven' | 'unknown';

/** Design doc §11, Applicability. */
export type ApplicabilityType =
  | 'global'
  | 'project'
  | 'directory-subtree'
  | 'tool-event'
  | 'config-rule'
  | 'runtime-defined'
  | 'unknown';

export interface Applicability {
  type: ApplicabilityType;
  target?: string;
}

/** Design doc §11, Resolution semantics. */
export type ResolutionStrategy =
  | 'override'
  | 'accumulate'
  | 'available'
  | 'policy'
  | 'event-pipeline'
  | 'runtime-defined'
  | 'unknown';

export interface Resolution {
  strategy: ResolutionStrategy;
  reason?: string;
}

/**
 * Design doc §13.4. `effective` means the element can affect agent process or
 * output under the current static environment and runtime semantics — an
 * on-demand skill is still effective (design doc §11).
 */
export type ResolvedStatus = 'effective' | 'shadowed' | 'conditional' | 'unresolved' | 'unknown';

export interface ResolvedElement {
  id: ElementId;

  status: ResolvedStatus;

  applicability?: Applicability;

  activation: Activation;

  resolution: Resolution;
}

/**
 * Design doc §14. Only explicit, statically resolvable edges are produced and
 * frozen for v1.0. The initial declaration also listed `contains`,
 * `discovered-from`, `resolves-to`, and `applies-to`; no adapter produces them
 * and each has an adequate structural representation already (`source.path` +
 * origin for provenance, `resolution.strategy`/`status` for resolution,
 * `applicability` for applicability), so they are withdrawn from the model
 * rather than carried as vestigial schema. The full table and the reasoning are
 * in `docs/design/relation-types.md`.
 */
export const RELATION_TYPES = ['accumulates-with', 'overrides', 'shadows'] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

/**
 * The four withdrawn members are gone from the model but not from the schema-1
 * read surface. `SNAPSHOT_SCHEMA_VERSION` is unchanged: a stored artifact was
 * valid under schema 1 if it used any of the seven values, and narrowing the
 * validator would make this reader reject an artifact the previous reader
 * accepted. The reader therefore stays permissive — it accepts the full schema-1
 * set — while no producer emits the withdrawn values, so no artifact this
 * version writes can contain one. A future schema bump can drop the legacy
 * reads; until then the two sets are deliberately separate.
 */
export const PERSISTED_RELATION_TYPES: readonly string[] = [
  ...RELATION_TYPES,
  'contains',
  'discovered-from',
  'resolves-to',
  'applies-to',
];

export interface Relation {
  type: RelationType;
  from: ElementId;
  to: ElementId;
}

/** Design doc §13.3, plus the id §25 shows (`res_…`) and storage needs. */
export interface ResolvedSnapshot {
  schemaVersion: string;
  snapshotId: ResolvedSnapshotId;
  observedSnapshotId: ObservedSnapshotId;

  runtime: {
    id: RuntimeId;
    version: string | null;
  };

  resolution: {
    semanticsVersion: string;
    confidence: 'verified' | 'unverified-runtime-version';
  };

  elements: ResolvedElement[];
  relations: Relation[];
  effectiveElementIds: ElementId[];
  diagnostics: Diagnostic[];

  digests: {
    harnessContent: string;
    resolvedSnapshot: string;
  };
}
