/**
 * Best-effort inspection reporting (design doc §18). Unreadable, unsupported,
 * skipped, or unknown elements are recorded here and never abort the scan.
 */

/** No numeric completeness score is used (design doc §18). */
export type Completeness = 'complete' | 'partial' | 'unknown';

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

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
