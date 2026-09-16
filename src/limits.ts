import type { Diagnostic } from './core/diagnostics.js';

/**
 * Resource ceilings (roadmap §5 M6, ADR 0002 §4). The values are named
 * constants, not user-configurable, and are deliberately shared between the
 * code that enforces them and the tests that exercise them, so a limit cannot
 * be changed without the hostile-input corpus moving with it.
 *
 * Exceeding a limit marks the affected element `skipped` with a stable
 * diagnostic code that names the limit and its value, and sets completeness to
 * `partial`. It never aborts the run.
 */

/** Bytes read from a single walked file. */
export const MAX_FILE_BYTES = 1_048_576;

/** Total entries recorded by one `walkHarnessPaths` call. */
export const MAX_WALK_ENTRIES = 10_000;

/** Directory recursion depth for one walk. */
export const MAX_WALK_DEPTH = 32;

/** Bytes read from one snapshot artifact (observation, resolution, interpretation). */
export const MAX_ARTIFACT_BYTES = 16_777_216;

/** Bytes fed to a JSON or TOML parser (settings files, `config.toml`, `hooks.json`). */
export const MAX_PARSE_BYTES = 1_048_576;

export type LimitName =
  | 'MAX_FILE_BYTES'
  | 'MAX_WALK_ENTRIES'
  | 'MAX_WALK_DEPTH'
  | 'MAX_ARTIFACT_BYTES'
  | 'MAX_PARSE_BYTES';

/**
 * A `limit-exceeded` diagnostic. It names the limit that was hit and its value
 * so a user who meets one in a large but legitimate repository can see why an
 * element was skipped, rather than only that it was skipped.
 */
export function limitExceededDiagnostic(limit: LimitName, value: number, path: string): Diagnostic {
  return {
    severity: 'warning',
    code: 'limit-exceeded',
    message: `limit exceeded: ${limit}=${value} while reading ${path}`,
    path,
  };
}
