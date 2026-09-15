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
 * Whether `version` falls inside the verified range. An unparseable version or
 * range is unverified (`false`), never assumed compatible.
 */
export function isWithinRange(version: string | null, range: VersionRange): boolean {
  if (version === null) return false;
  const parsed = parseVersion(version);
  const min = parseVersion(range.min);
  const max = parseVersion(range.max);
  if (parsed === null || min === null || max === null) return false;
  return compareVersions(parsed, min) >= 0 && compareVersions(parsed, max) < 0;
}
