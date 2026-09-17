import type { Diagnostic } from '../core/diagnostics.js';
import type { ObservedElement } from '../core/observed.js';
import type { Logger } from '../util/logger.js';
import { applyRedactionRules, type RedactionLevel } from './common.js';
import { ALL_REDACTION_RULES } from './rules.js';

/**
 * Output redaction (design doc §19, §20; roadmap S6, S8). Every field that
 * leaves the process — persisted into a snapshot or printed — passes through
 * the allowlist, the redaction layer, or both. The rules are the common policy
 * plus every runtime's, so a runtime-specific credential shape (`sk-ant-…`,
 * `sess-…`) is masked wherever it appears, not only in adapter metadata.
 *
 * Two kinds of text need different treatment:
 *
 * - **Paths** carry the account name (an absolute project root, or the
 *   `/`→`-` encoded project directory Claude Code uses for memory). They get
 *   the home directory replaced by `~`, plus the token/secret rules. The
 *   high-entropy heuristic is deliberately **not** applied to paths: it would
 *   redact legitimate long path segments (an encoded project directory is one
 *   long `-`-joined run).
 * - **Free text** (diagnostic messages, error strings) gets the full policy at
 *   the channel's level, high-entropy rule included.
 */

export interface RedactionContext {
  /** The user's home directory, replaced by `~` wherever it appears as a path. */
  home: string;
}

/** Rules that apply to paths: everything except the high-entropy heuristic. */
const PATH_RULES = ALL_REDACTION_RULES.filter((rule) => rule.from !== 'export');

/**
 * Replaces `needle` with `~` only where it is followed by `boundary` or the end
 * of the string. A literal scan rather than a constructed regular expression, so
 * a value here cannot become a pattern.
 */
function replaceAtBoundary(value: string, needle: string, boundary: string): string {
  const parts: string[] = [];
  let cursor = 0;
  for (;;) {
    const at = value.indexOf(needle, cursor);
    if (at === -1) {
      parts.push(value.slice(cursor));
      return parts.join('');
    }
    parts.push(value.slice(cursor, at));
    const after = value[at + needle.length];
    parts.push(after === undefined || after === boundary ? '~' : needle);
    cursor = at + needle.length;
  }
}

/**
 * Replaces the home directory with `~` only where it is followed by a path
 * separator or the end of the string. This is what keeps `/Users/alice2` intact
 * when the home is `/Users/alice`, and stops the encoded `-Users-alice` from
 * matching a longer `-Users-alice2` run.
 */
function replaceHomeSegment(value: string, home: string): string {
  const encodedHome = home.replaceAll('/', '-');
  return replaceAtBoundary(replaceAtBoundary(value, home, '/'), encodedHome, '-');
}

/**
 * Replaces the home directory with `~`, in both its raw and its Claude Code
 * `/`→`-` encoded form, so a path carries a shape without the account name.
 */
export function redactHomePath(value: string, home: string): string {
  if (home.length <= 1) return value;
  return replaceHomeSegment(value, home);
}

/** Redacts a filesystem path: home prefix plus the token/secret rules. */
export function redactPath(value: string, ctx: RedactionContext): string {
  return redactHomePath(applyRedactionRules(value, PATH_RULES, 'persistence'), ctx.home);
}

/** Redacts free text at the given level, then strips the home prefix. */
export function redactFreeText(
  value: string,
  level: RedactionLevel,
  ctx: RedactionContext,
): string {
  return redactHomePath(applyRedactionRules(value, ALL_REDACTION_RULES, level), ctx.home);
}

/** Redacts a diagnostic's message and optional path. */
export function redactDiagnostic(
  diagnostic: Diagnostic,
  level: RedactionLevel,
  ctx: RedactionContext,
): Diagnostic {
  return {
    ...diagnostic,
    message: redactFreeText(diagnostic.message, level, ctx),
    ...(diagnostic.path !== undefined ? { path: redactPath(diagnostic.path, ctx) } : {}),
  };
}

/** Redacts an observed element's source path, leaving structural fields intact. */
export function redactElementSource(
  element: ObservedElement,
  ctx: RedactionContext,
): ObservedElement {
  const path = element.source.path;
  if (path === undefined) return element;
  return { ...element, source: { ...element.source, path: redactPath(path, ctx) } };
}

/**
 * Wraps a logger so every message and a top-level string `path` in its
 * structured data is redacted at the channel's level. Structural fields (ids,
 * digests, counts) pass through untouched, and nested payloads are assumed
 * already redacted at persistence (snapshots and diagnostics are). This is the
 * display/export choke point for CLI output that is produced at read time and
 * never persisted.
 */
export function redactingLogger(
  logger: Logger,
  level: RedactionLevel,
  ctx: RedactionContext,
): Logger {
  const data = (value?: Record<string, unknown>): Record<string, unknown> | undefined => {
    if (value === undefined) return undefined;
    const path = value['path'];
    return typeof path === 'string' ? { ...value, path: redactPath(path, ctx) } : value;
  };
  return {
    info: (message, extra) => logger.info(redactFreeText(message, level, ctx), data(extra)),
    warn: (message, extra) => logger.warn(redactFreeText(message, level, ctx), data(extra)),
    error: (message, extra) => logger.error(redactFreeText(message, level, ctx), data(extra)),
  };
}
