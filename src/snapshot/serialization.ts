import { canonicalJsonStringify } from '../util/json.js';

/**
 * On-disk snapshot serialization (design doc §15, §33). The decision is
 * recorded in `docs/design/adr/0001-snapshot-serialization-and-ids.md`.
 *
 * Format: one file per snapshot, newline-terminated canonical JSON via
 * `canonicalJsonStringify`. Canonical key ordering makes the bytes (and any
 * digest over them) independent of object insertion order, and the trailing
 * newline keeps the file POSIX-text friendly.
 */

/**
 * Schema versioning policy: `schemaVersion` is a decimal integer string
 * (`"1"`, `"2"`, …). It increments when the persisted shape changes in a way an
 * older reader cannot safely interpret — a field added, removed, retyped, or
 * given new meaning. A reader supports an explicit set of versions and refuses
 * an unknown one rather than guessing (observe-don't-infer); snapshots are
 * immutable, so an unreadable snapshot is never rewritten or migrated in place.
 */
export const SNAPSHOT_SCHEMA_VERSION = '1';
export const SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS: readonly string[] = [SNAPSHOT_SCHEMA_VERSION];

/** Every persisted snapshot carries a schema version. */
export interface VersionedSnapshot {
  schemaVersion: string;
}

export class UnsupportedSchemaVersionError extends Error {
  constructor(
    public readonly schemaVersion: string,
    public readonly supported: readonly string[],
  ) {
    super(
      `unsupported snapshot schema version: ${schemaVersion} (supported: ${supported.join(', ')})`,
    );
    this.name = 'UnsupportedSchemaVersionError';
  }
}

export class InvalidSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSnapshotError';
  }
}

/** Serializes a snapshot to newline-terminated canonical JSON. */
export function serializeSnapshot<T extends VersionedSnapshot>(snapshot: T): string {
  return `${canonicalJsonStringify(snapshot)}\n`;
}

/**
 * Parses a serialized snapshot, rejecting anything that is not a JSON object
 * carrying a supported `schemaVersion`.
 */
export function deserializeSnapshot<T extends VersionedSnapshot>(
  text: string,
  supported: readonly string[] = SUPPORTED_SNAPSHOT_SCHEMA_VERSIONS,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InvalidSnapshotError('snapshot is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidSnapshotError('snapshot is not a JSON object');
  }
  const { schemaVersion } = parsed as { schemaVersion?: unknown };
  if (typeof schemaVersion !== 'string') {
    throw new InvalidSnapshotError('snapshot is missing a string schemaVersion');
  }
  if (!supported.includes(schemaVersion)) {
    throw new UnsupportedSchemaVersionError(schemaVersion, supported);
  }
  return parsed as T;
}
