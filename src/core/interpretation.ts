import type { HarnessFacet } from './facets.js';
import type { ElementId, InterpretationId, ResolvedSnapshotId } from './ids.js';

/**
 * Derived Interpretation: recomputable higher-level interpretation of a
 * ResolvedSnapshot (design doc §7.3, §21). Classification is deterministic,
 * local, LLM-free, best-effort, and inspectable; native facts remain
 * authoritative even when classification is imperfect.
 */

export const CLASSIFICATION_CONFIDENCE_VALUES = ['high', 'medium', 'unknown'] as const;
export type ClassificationConfidence = (typeof CLASSIFICATION_CONFIDENCE_VALUES)[number];

export interface ElementInterpretation {
  elementId: ElementId;
  facets: HarnessFacet[];
  confidence: ClassificationConfidence;
  /** Why the classification was reached (design doc §21: inspectable). */
  reason: string;
}

export interface HarnessStats {
  observed: number;
  effective: number;
  shadowed: number;
  conditional: number;
  opaque: number;
  byFacet: Partial<Record<HarnessFacet, number>>;
}

/** Initial finding rules (design doc §22). Descriptive, never evaluative. */
export const FINDING_RULES = [
  'shadowed-element',
  'conflicting-scope',
  'opaque-runtime-layer',
  'broad-tool-access',
  'conditional-heavy',
  'memory-enabled',
  'subtree-specific-instruction',
] as const;

export type FindingRuleId = (typeof FINDING_RULES)[number];

export interface Finding {
  rule: FindingRuleId;
  message: string;
  elementIds: ElementId[];
}

export interface Interpretation {
  /**
   * The on-disk schema of the interpretation artifact, governed by
   * `SNAPSHOT_SCHEMA_VERSION` like every other stored artifact. Persisted since
   * v1.0, when interpretations stopped being recomputed on every read.
   */
  schemaVersion: string;

  interpretationId: InterpretationId;
  resolvedSnapshotId: ResolvedSnapshotId;

  /**
   * The classifier that produced this interpretation. `version` is the
   * `CLASSIFIER_VERSION` constant; it does not feed any digest, so a classifier
   * change never invalidates a stored snapshot.
   */
  classifier: {
    id: string;
    version: string;
  };

  elements: ElementInterpretation[];

  stats: HarnessStats;
  findings: Finding[];
}
