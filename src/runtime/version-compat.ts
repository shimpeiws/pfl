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

/**
 * A **discrete** set of verified versions, for a runtime whose verified evidence
 * names exact versions rather than a floor and ceiling (OpenCode: 1.18.0,
 * 1.18.30, 1.18.31 — model doc §0). A `VersionRange` is continuous, so encoding
 * a set as a range would claim every version between the members was verified.
 * Membership is by normalized `major.minor.patch`.
 */
export interface VersionSet {
  /** Normalized versions; order does not matter. */
  versions: readonly string[];
}

/** Whether `version` is one of the verified versions, normalized. */
export function isVersionInSet(version: string | null, set: VersionSet): boolean {
  if (version === null) return false;
  const parsed = parseVersion(version);
  if (parsed === null) return false;
  const normalized = formatVersion(parsed);
  return set.versions.some((candidate) => {
    const member = parseVersion(candidate);
    return member !== null && formatVersion(member) === normalized;
  });
}

/**
 * Where a version sits relative to a discrete verified set: `within` when it is
 * a member, `below` below the lowest member, `above` above the highest, and
 * `unknown` when it falls inside the numeric span without being a verified
 * member. The last case is deliberately not `within`: a version between two
 * verified members is not itself verified (design doc §17, model doc §0).
 */
export function versionSetPosition(version: string | null, set: VersionSet): VersionPosition {
  const parsed = version === null ? null : parseVersion(version);
  if (parsed === null) return 'unknown';
  if (isVersionInSet(version, set)) return 'within';

  const members = set.versions
    .map((candidate) => parseVersion(candidate))
    .filter((candidate): candidate is ParsedVersion => candidate !== null);
  if (members.length === 0) return 'unknown';

  let lowest = members[0] as ParsedVersion;
  let highest = members[0] as ParsedVersion;
  for (const member of members) {
    if (compareVersions(member, lowest) < 0) lowest = member;
    if (compareVersions(member, highest) > 0) highest = member;
  }
  if (compareVersions(parsed, lowest) < 0) return 'below';
  if (compareVersions(parsed, highest) > 0) return 'above';
  return 'unknown';
}
