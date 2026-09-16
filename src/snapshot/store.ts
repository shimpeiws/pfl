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
import type { ResolvedSnapshot } from '../core/resolved.js';
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
 * The layout mirrors the data model (design doc §15 distinguishes an observation
 * event from harness state):
 *
 * - `observations/` holds the ObservedSnapshot an `inspect` run captured — the
 *   observation event, with `capturedAt` and `completeness`.
 * - `snapshots/` holds the ResolvedSnapshot — the resolved harness state.
 * - `interpretations/` holds a Derived Interpretation (M3).
 * - `latest` is a small `{"observed": "obs_…", "resolved": "res_…"}` pointer:
 *   the one mutable artifact, replaced atomically.
 *
 * This module writes exactly what it is handed and never reaches back into the
 * filesystem for content. Snapshots are immutable: an existing id is a conflict,
 * not an update, and a new snapshot is linked into place atomically. The project
 * id and artifact ids are boundary input, so each is validated against a safe
 * charset before it becomes a path segment.
 */

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const ARTIFACT_SUFFIX = '.json';
const LATEST_FILE = 'latest';
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMPLETENESS_VALUES: readonly string[] = ['complete', 'partial', 'unknown'];
const RESOLVED_STATUS_VALUES: readonly string[] = [
  'effective',
  'shadowed',
  'conditional',
  'unresolved',
  'unknown',
];
const ACTIVATION_VALUES: readonly string[] = [
  'always',
  'conditional',
  'on-demand',
  'event-driven',
  'unknown',
];
const STRATEGY_VALUES: readonly string[] = [
  'override',
  'accumulate',
  'available',
  'policy',
  'event-pipeline',
  'runtime-defined',
  'unknown',
];
const APPLICABILITY_VALUES: readonly string[] = [
  'global',
  'project',
  'directory-subtree',
  'tool-event',
  'config-rule',
  'runtime-defined',
  'unknown',
];
const RELATION_TYPE_VALUES: readonly string[] = [
  'contains',
  'discovered-from',
  'accumulates-with',
  'overrides',
  'shadows',
  'resolves-to',
  'applies-to',
];

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

/** A run's stable facts: one observation event and its resolved snapshot (§23). */
export interface StoredRunSummary {
  observedId: string;
  resolvedId: string | null;
  capturedAt: string;
  runtime: { id: string; version: string | null };
  completeness: Completeness;
}

export interface RunListResult {
  runs: StoredRunSummary[];
  diagnostics: Diagnostic[];
}

/** The `latest` pointer: the ids read commands default to (design doc §23). */
export interface LatestPointer {
  observed: string;
  resolved: string;
}

/** Persists an ObservedSnapshot (an observation event). */
export async function writeObservedSnapshot(
  projectId: string,
  snapshot: ObservedSnapshot,
  home: string = homedir(),
): Promise<void> {
  await writeArtifact(
    artifactPath(observationsDir(projectId, home), snapshot.snapshotId),
    serializeSnapshot(snapshot),
  );
}

export async function readObservedSnapshot(
  projectId: string,
  snapshotId: string,
  home: string = homedir(),
): Promise<ObservedSnapshot> {
  return readArtifact(
    artifactPath(observationsDir(projectId, home), snapshotId),
    isObservedSnapshot,
  );
}

/** Persists a ResolvedSnapshot (the resolved harness state). */
export async function writeResolvedSnapshot(
  projectId: string,
  snapshot: ResolvedSnapshot,
  home: string = homedir(),
): Promise<void> {
  await writeArtifact(
    artifactPath(snapshotsDir(projectId, home), snapshot.snapshotId),
    serializeSnapshot(snapshot),
  );
}

export async function readResolvedSnapshot(
  projectId: string,
  snapshotId: string,
  home: string = homedir(),
): Promise<ResolvedSnapshot> {
  return readArtifact(artifactPath(snapshotsDir(projectId, home), snapshotId), isResolvedSnapshot);
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

/** The default for read commands: no `--snapshot` means `latest` (design doc §23). */
export async function readLatestPointer(
  projectId: string,
  home: string = homedir(),
): Promise<LatestPointer | null> {
  let text: string;
  try {
    text = await readFile(latestPath(projectId, home), 'utf8');
  } catch (error) {
    if (isNotFound(error)) return null;
    throw snapshotStoreError(`could not read the latest pointer: ${errorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw snapshotStoreError('the latest pointer is not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw snapshotStoreError('the latest pointer is not a JSON object');
  }
  const observed = parsed['observed'];
  const resolved = parsed['resolved'];
  if (typeof observed !== 'string' || typeof resolved !== 'string') {
    throw snapshotStoreError('the latest pointer is missing an id');
  }
  return { observed, resolved };
}

/** Points `latest` at a run. The pointer is mutable and replaced atomically. */
export async function writeLatestPointer(
  projectId: string,
  pointer: LatestPointer,
  home: string = homedir(),
): Promise<void> {
  assertSafeSegment(pointer.observed, 'snapshot id');
  assertSafeSegment(pointer.resolved, 'snapshot id');

  const target = latestPath(projectId, home);
  await ensureDir(dirname(target));
  const temp = tempPath(target);
  try {
    await writeFile(temp, `${JSON.stringify(pointer)}\n`, { mode: FILE_MODE });
    await chmod(temp, FILE_MODE);
    await rename(temp, target);
  } catch (error) {
    throw snapshotStoreError(`could not write the latest pointer: ${errorMessage(error)}`);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

/** Lists runs (observation + its resolved snapshot), newest first. */
export async function listRuns(
  projectId: string,
  home: string = homedir(),
): Promise<RunListResult> {
  const diagnostics: Diagnostic[] = [];
  const observedDir = observationsDir(projectId, home);
  const resolvedDir = snapshotsDir(projectId, home);

  const resolvedByObserved = new Map<string, string>();
  for (const name of await artifactNames(resolvedDir, diagnostics)) {
    try {
      const resolved = await readArtifact(join(resolvedDir, name), isResolvedSnapshot);
      resolvedByObserved.set(resolved.observedSnapshotId, resolved.snapshotId);
    } catch (error) {
      diagnostics.push({
        severity: 'warning',
        code: 'unreadable-snapshot',
        message: errorMessage(error),
        path: name,
      });
    }
  }

  const runs: StoredRunSummary[] = [];
  for (const name of await artifactNames(observedDir, diagnostics)) {
    try {
      const observed = await readArtifact(join(observedDir, name), isObservedSnapshot);
      runs.push({
        observedId: observed.snapshotId,
        resolvedId: resolvedByObserved.get(observed.snapshotId) ?? null,
        capturedAt: observed.capturedAt,
        runtime: { id: observed.runtime.id, version: observed.runtime.version },
        completeness: observed.completeness,
      });
    } catch (error) {
      diagnostics.push({
        severity: 'warning',
        code: 'unreadable-observation',
        message: errorMessage(error),
        path: name,
      });
    }
  }

  runs.sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : 0));
  return { runs, diagnostics };
}

async function artifactNames(dir: string, diagnostics: Diagnostic[]): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(ARTIFACT_SUFFIX));
  } catch (error) {
    if (isNotFound(error)) return [];
    diagnostics.push({
      severity: 'error',
      code: 'snapshot-store-unreadable',
      message: `could not read the snapshot store: ${errorMessage(error)}`,
      path: dir,
    });
    return [];
  }
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

function isResolvedSnapshot(value: unknown): value is ResolvedSnapshot {
  if (!isRecord(value)) return false;
  if (typeof value['snapshotId'] !== 'string' || typeof value['observedSnapshotId'] !== 'string') {
    return false;
  }
  const runtime = value['runtime'];
  if (!isRecord(runtime) || typeof runtime['id'] !== 'string') return false;

  const resolution = value['resolution'];
  if (!isRecord(resolution) || typeof resolution['semanticsVersion'] !== 'string') return false;
  const confidence = resolution['confidence'];
  if (confidence !== 'verified' && confidence !== 'unverified-runtime-version') return false;

  if (
    !Array.isArray(value['elements']) ||
    !value['elements'].every(isResolvedElement) ||
    !Array.isArray(value['relations']) ||
    !value['relations'].every(isRelation) ||
    !Array.isArray(value['effectiveElementIds']) ||
    !value['effectiveElementIds'].every((id) => typeof id === 'string') ||
    !Array.isArray(value['diagnostics'])
  ) {
    return false;
  }

  const digests = value['digests'];
  return (
    isRecord(digests) &&
    typeof digests['harnessContent'] === 'string' &&
    typeof digests['resolvedSnapshot'] === 'string'
  );
}

function isResolvedElement(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value['id'] !== 'string') return false;
  if (typeof value['status'] !== 'string' || !RESOLVED_STATUS_VALUES.includes(value['status'])) {
    return false;
  }
  const activation = value['activation'];
  if (typeof activation !== 'string' || !ACTIVATION_VALUES.includes(activation)) return false;
  const resolution = value['resolution'];
  if (!isRecord(resolution)) return false;
  const strategy = resolution['strategy'];
  if (typeof strategy !== 'string' || !STRATEGY_VALUES.includes(strategy)) return false;
  const applicability = value['applicability'];
  if (applicability !== undefined) {
    if (!isRecord(applicability)) return false;
    const type = applicability['type'];
    if (typeof type !== 'string' || !APPLICABILITY_VALUES.includes(type)) return false;
  }
  return true;
}

function isRelation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const type = value['type'];
  return (
    typeof type === 'string' &&
    RELATION_TYPE_VALUES.includes(type) &&
    typeof value['from'] === 'string' &&
    typeof value['to'] === 'string'
  );
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
