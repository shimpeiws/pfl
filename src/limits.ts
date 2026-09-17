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

/**
 * Frontmatter-derived metadata shape ceilings (roadmap §5 M7, issue #68). The
 * parse input is already bounded by `MAX_FILE_BYTES`, but a hostile file can
 * still declare an unbounded number of keys or tool names, so the *output* is
 * bounded too and a cap hit is recorded as malformed rather than silently
 * truncated. Shared with the tests, so a value cannot change without the corpus
 * moving with it.
 */
export const MAX_FRONTMATTER_KEYS = 64;
export const MAX_TOOL_NAMES = 64;
export const MAX_TOOL_NAME_LENGTH = 200;

/**
 * TOML reader shape ceilings (roadmap §5 M7, issue #74). The parse input is
 * already bounded, but a hostile `config.toml` can still declare a deeply nested
 * section path or an enormous array, so the reader bounds section depth, array
 * length, and scalar string length. Hitting one records the file as malformed
 * rather than allocating without limit.
 */
export const MAX_TOML_SECTION_DEPTH = 8;
export const MAX_TOML_ARRAY_ITEMS = 256;
export const MAX_TOML_SCALAR_LENGTH = 256;

/**
 * Ancestor-directory ceiling (roadmap §5 M7, issue #75). Codex reads
 * `AGENTS.md` from the project's parent directories, which is an out-of-project
 * read, so the upward walk is bounded rather than roaming to the filesystem
 * root. Hitting the ceiling is recorded as a diagnostic, so a project nested
 * deeper than this is visibly truncated rather than silently missing ancestors.
 */
export const MAX_ANCESTOR_DIRS = 16;

export type LimitName =
  | 'MAX_FILE_BYTES'
  | 'MAX_WALK_ENTRIES'
  | 'MAX_WALK_DEPTH'
  | 'MAX_ARTIFACT_BYTES'
  | 'MAX_PARSE_BYTES'
  | 'MAX_ANCESTOR_DIRS';

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
