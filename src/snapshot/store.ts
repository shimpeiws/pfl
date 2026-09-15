import { randomBytes } from 'node:crypto';
import {
  access,
  chmod,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { EXIT_CODES, PflError } from '../cli/exit-codes.js';
import type { Completeness, Diagnostic } from '../core/diagnostics.js';
import type { Interpretation } from '../core/interpretation.js';
import type { ObservedSnapshot } from '../core/observed.js';
import { deserializeSnapshot, serializeSnapshot, type VersionedSnapshot } from './serialization.js';

/**
 * Storage layout (design doc §29). pfl stores data under the user's home
 * directory rather than modifying the inspected repository; no project-local
 * data directory exists in v0.1.
 *
 * ```text
 * ~/.pfl/
 *   permissions.json
 *   projects/
 *     <project-id>/
 *       observations/
 *       snapshots/
 *       interpretations/
 *       latest
 * ```
 *
 * `snapshots/` holds the ObservedSnapshot produced by `inspect` — the artifact
 * `pfl snapshots` lists and `latest` points at, and the one carrying
 * `capturedAt` and `completeness`. `observations/` and `interpretations/` are
 * read targets for the other data-model layers (design doc §7); no writer fills
 * them in v0.1. This module writes exactly what it is handed and never reaches
 * back into the filesystem for content.
 *
 * Snapshots are immutable: an existing id is a conflict, not an update, and a
 * new snapshot is linked into place atomically. The `latest` pointer is the one
 * mutable artifact and is replaced atomically.
 *
 * The project id and artifact ids are treated as boundary input: they become
 * path segments, so each is validated against a safe charset before use.
 */

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const ARTIFACT_SUFFIX = '.json';
const LATEST_FILE = 'latest';
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMPLETENESS_VALUES: readonly string[] = ['complete', 'partial', 'unknown'];

export function pflHome(home: string = homedir()): string {
  return join(home, '.pfl');
}

export function permissionsPath(home: string = homedir()): string {
  return join(pflHome(home), 'permissions.json');
}

export function projectDir(projectId: string, home: string = homedir()): string {
  assertSafeSegment(projectId, 'project id');
  return join(pflHome(home), 'projects', projectId);
}

export function observationsDir(projectId: string, home: string = homedir()): string {
  return join(projectDir(projectId, home), 'observations');
}

export function snapshotsDir(projectId: string, home: string = homedir()): string {
  return join(projectDir(projectId, home), 'snapshots');
}

export function interpretationsDir(projectId: string, home: string = homedir()): string {
  return join(projectDir(projectId, home), 'interpretations');
}

export function latestPath(projectId: string, home: string = homedir()): string {
  return join(projectDir(projectId, home), LATEST_FILE);
}

/** A listed snapshot's stable facts (design doc §23). */
export interface StoredSnapshotSummary {
  id: string;
  capturedAt: string;
  runtime: { id: string; version: string | null };
  completeness: Completeness;
}

export interface SnapshotListResult {
  snapshots: StoredSnapshotSummary[];
  diagnostics: Diagnostic[];
}

/**
 * Persists an ObservedSnapshot. Snapshots are immutable; writing an existing id
 * is a conflict, not an update.
 */
export async function writeSnapshot(
  projectId: string,
  snapshot: ObservedSnapshot,
  home: string = homedir(),
): Promise<void> {
  await writeArtifact(
    artifactPath(snapshotsDir(projectId, home), snapshot.snapshotId),
    serializeSnapshot(snapshot),
  );
}

/** Reads an ObservedSnapshot by id. */
export async function readSnapshot(
  projectId: string,
  snapshotId: string,
  home: string = homedir(),
): Promise<ObservedSnapshot> {
  return readArtifact(artifactPath(snapshotsDir(projectId, home), snapshotId), isObservedSnapshot);
}

/** Reads an observation event by id (`observations/`). */
export async function readObservation(
  projectId: string,
  observationId: string,
  home: string = homedir(),
): Promise<ObservedSnapshot> {
  return readArtifact(
    artifactPath(observationsDir(projectId, home), observationId),
    isObservedSnapshot,
  );
}

/** Reads a Derived Interpretation by id (`interpretations/`). */
export async function readInterpretation(
  projectId: string,
  interpretationId: string,
  home: string = homedir(),
): Promise<Interpretation> {
  return readArtifact(
    artifactPath(interpretationsDir(projectId, home), interpretationId),
    isInterpretation,
  );
}

/** The default snapshot for read commands: no `--snapshot` means `latest`. */
export async function readLatestSnapshotId(
  projectId: string,
  home: string = homedir(),
): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(latestPath(projectId, home), 'utf8');
  } catch (error) {
    if (isNotFound(error)) return null;
    throw snapshotStoreError(`could not read the latest pointer: ${errorMessage(error)}`);
  }
  const id = text.trim();
  return id ? id : null;
}

/** Points `latest` at a snapshot id. The pointer is mutable and replaced atomically. */
export async function writeLatestSnapshotId(
  projectId: string,
  snapshotId: string,
  home: string = homedir(),
): Promise<void> {
  assertSafeSegment(snapshotId, 'snapshot id');
  const target = latestPath(projectId, home);
  await ensureDir(dirname(target));
  const temp = tempPath(target);
  try {
    await writeFile(temp, `${snapshotId}\n`, { mode: FILE_MODE });
    await chmod(temp, FILE_MODE);
    await rename(temp, target);
  } catch (error) {
    throw snapshotStoreError(`could not write the latest pointer: ${errorMessage(error)}`);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

/** Lists stored snapshots, newest first, recording unreadable ones as diagnostics. */
export async function listSnapshots(
  projectId: string,
  home: string = homedir(),
): Promise<SnapshotListResult> {
  const dir = snapshotsDir(projectId, home);

  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isNotFound(error)) return { snapshots: [], diagnostics: [] };
    return {
      snapshots: [],
      diagnostics: [
        {
          severity: 'error',
          code: 'snapshot-store-unreadable',
          message: `could not read the snapshot store: ${errorMessage(error)}`,
          path: dir,
        },
      ],
    };
  }

  const snapshots: StoredSnapshotSummary[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const name of names) {
    if (!name.endsWith(ARTIFACT_SUFFIX)) continue;
    try {
      const snapshot = await readArtifact(join(dir, name), isObservedSnapshot);
      snapshots.push({
        id: snapshot.snapshotId,
        capturedAt: snapshot.capturedAt,
        runtime: { id: snapshot.runtime.id, version: snapshot.runtime.version },
        completeness: snapshot.completeness,
      });
    } catch (error) {
      diagnostics.push({
        severity: 'warning',
        code: 'unreadable-snapshot',
        message: errorMessage(error),
        path: name,
      });
    }
  }

  snapshots.sort((a, b) =>
    a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : 0,
  );
  return { snapshots, diagnostics };
}

function artifactPath(dir: string, id: string): string {
  assertSafeSegment(id, 'artifact id');
  return join(dir, `${id}${ARTIFACT_SUFFIX}`);
}

async function readArtifact<T>(
  target: string,
  isValid: (value: unknown) => value is T,
): Promise<T> {
  let text: string;
  try {
    text = await readFile(target, 'utf8');
  } catch (error) {
    if (isNotFound(error)) throw snapshotStoreError(`snapshot not found: ${basename(target)}`);
    throw snapshotStoreError(`could not read snapshot: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    // The on-disk envelope always carries `schemaVersion` (ADR 0001), even when
    // the artifact type itself does not model it (for example Interpretation).
    parsed = deserializeSnapshot<VersionedSnapshot>(text);
  } catch (error) {
    throw snapshotStoreError(errorMessage(error));
  }

  if (!isValid(parsed)) {
    throw snapshotStoreError(`snapshot is missing required fields: ${basename(target)}`);
  }
  return parsed;
}

/**
 * Writes `content` to `target` without overwriting. The bytes go to a temp file
 * first, then `link` publishes them atomically and fails with `EEXIST` if the
 * id already exists, so a conflict never touches the original file.
 */
async function writeArtifact(target: string, content: string): Promise<void> {
  const dir = dirname(target);
  await ensureDir(dir);
  if (await exists(target)) {
    throw snapshotStoreError(`snapshot already exists: ${basename(target)}`);
  }

  const temp = tempPath(target);
  try {
    await writeFile(temp, content, { mode: FILE_MODE });
    await chmod(temp, FILE_MODE);
    await link(temp, target);
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw snapshotStoreError(`snapshot already exists: ${basename(target)}`);
    }
    throw snapshotStoreError(`could not write snapshot: ${errorMessage(error)}`);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  try {
    await chmod(dir, DIR_MODE);
  } catch (error) {
    throw snapshotStoreError(`could not set permissions on ${dir}: ${errorMessage(error)}`);
  }
}

function tempPath(target: string): string {
  return `${target}.${randomBytes(6).toString('hex')}.tmp`;
}

function assertSafeSegment(segment: string, what: string): void {
  if (!SAFE_SEGMENT.test(segment)) {
    throw snapshotStoreError(`invalid ${what}: ${JSON.stringify(segment)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isObservedSnapshot(value: unknown): value is ObservedSnapshot {
  if (!isRecord(value)) return false;
  if (typeof value['snapshotId'] !== 'string' || typeof value['capturedAt'] !== 'string') {
    return false;
  }
  const project = value['project'];
  if (!isRecord(project) || typeof project['id'] !== 'string') return false;
  const runtime = value['runtime'];
  if (!isRecord(runtime) || typeof runtime['id'] !== 'string') return false;
  if (!(runtime['version'] === null || typeof runtime['version'] === 'string')) return false;
  const adapter = value['adapter'];
  if (!isRecord(adapter) || typeof adapter['id'] !== 'string') return false;
  if (!Array.isArray(value['elements']) || !Array.isArray(value['diagnostics'])) return false;
  const completeness = value['completeness'];
  if (typeof completeness !== 'string' || !COMPLETENESS_VALUES.includes(completeness)) return false;
  const digests = value['digests'];
  return isRecord(digests) && typeof digests['observed'] === 'string';
}

function isInterpretation(value: unknown): value is Interpretation {
  if (!isRecord(value)) return false;
  return (
    typeof value['interpretationId'] === 'string' &&
    typeof value['resolvedSnapshotId'] === 'string' &&
    isRecord(value['classifier']) &&
    Array.isArray(value['elements']) &&
    isRecord(value['stats']) &&
    Array.isArray(value['findings'])
  );
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: string }).code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return (error as { code?: string }).code === 'EEXIST';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function snapshotStoreError(message: string): PflError {
  return new PflError(message, EXIT_CODES.SNAPSHOT_STORE_FAILED);
}
