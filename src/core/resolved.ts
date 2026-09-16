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

/** Design doc §14. Only explicit, statically resolvable edges are required initially. */
export const RELATION_TYPES = [
  'contains',
  'discovered-from',
  'accumulates-with',
  'overrides',
  'shadows',
  'resolves-to',
  'applies-to',
] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

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
