/**
 * Best-effort inspection reporting (design doc §18). Unreadable, unsupported,
 * skipped, or unknown elements are recorded here and never abort the scan.
 */

/** No numeric completeness score is used (design doc §18). */
export const COMPLETENESS_VALUES = ['complete', 'partial', 'unknown'] as const;
export type Completeness = (typeof COMPLETENESS_VALUES)[number];

export const DIAGNOSTIC_SEVERITY_VALUES = ['info', 'warning', 'error'] as const;
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITY_VALUES)[number];

/**
 * A non-fatal observation note. The design document does not fix a diagnostic
 * shape; this is a provisional scaffold shape and may change.
 */
export interface Diagnostic {
  severity: DiagnosticSeverity;
  /** Stable machine-readable code, e.g. `unsupported-by-adapter`. */
  code: string;
  message: string;
  /** Path the diagnostic relates to, when applicable. */
  path?: string;
}
