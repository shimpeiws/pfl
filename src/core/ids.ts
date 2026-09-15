/**
 * Stable identifiers used across the three data-model layers
 * (Observed Facts / Resolved Facts / Derived Interpretation, design doc §7).
 */

/** Identifies a harness element within an observation/resolution. */
export type ElementId = string;

/** Identifies an immutable ObservedSnapshot. */
export type ObservedSnapshotId = string;

/** Identifies an immutable ResolvedSnapshot. */
export type ResolvedSnapshotId = string;

/** Identifies a Derived Interpretation. */
export type InterpretationId = string;

/**
 * Stable runtime identifier. Should match `yuurei` where possible (design doc
 * §9); the initial set is `claude-code` and `codex`.
 */
export type RuntimeId = string;
