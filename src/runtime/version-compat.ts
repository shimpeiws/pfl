/**
 * Runtime-version compatibility (design doc §17). An adapter declares a
 * verified range as data; a detected version is compared against it. A version
 * that cannot be parsed is never guessed — it is unverified.
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Half-open range `[min, max)`. */
export interface VersionRange {
  min: string;
  max: string;
}

const VERSION_PREFIX = /^(\d+)\.(\d+)\.(\d+)/;

/** Parses a leading `major.minor.patch`, tolerating suffixes like `-aarch64`. */
export function parseVersion(value: string): ParsedVersion | null {
  const match = VERSION_PREFIX.exec(value.trim());
  if (!match) return null;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

export function formatVersion(version: ParsedVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** The highest parseable version among candidates, normalized, or null. */
export function highestVersion(candidates: readonly string[]): string | null {
  let best: ParsedVersion | null = null;
  for (const candidate of candidates) {
    const parsed = parseVersion(candidate);
    if (parsed === null) continue;
    if (best === null || compareVersions(parsed, best) > 0) best = parsed;
  }
  return best === null ? null : formatVersion(best);
}

/**
 * Where a version sits relative to the verified range. `unknown` when either
 * side cannot be parsed, so an unparseable version is never assumed compatible.
 * `below` and `above` are separate answers because they are separate facts: a
 * version older than the range may predate a semantic the adapter uses, which
 * is not the same claim as a version newer than it (design doc §17).
 */
export type VersionPosition = 'below' | 'within' | 'above' | 'unknown';

export function versionPosition(version: string | null, range: VersionRange): VersionPosition {
  if (version === null) return 'unknown';
  const parsed = parseVersion(version);
  const min = parseVersion(range.min);
  const max = parseVersion(range.max);
  if (parsed === null || min === null || max === null) return 'unknown';
  if (compareVersions(parsed, min) < 0) return 'below';
  if (compareVersions(parsed, max) >= 0) return 'above';
  return 'within';
}

/**
 * Whether `version` falls inside the verified range. Any position other than
 * `within` — including `unknown` — is not verified.
 */
export function isWithinRange(version: string | null, range: VersionRange): boolean {
  return versionPosition(version, range) === 'within';
}
