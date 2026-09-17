import { randomBytes } from 'node:crypto';
import { access, chmod, link, mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { EXIT_CODES, PflError } from '../cli/exit-codes.js';
import type { Completeness, Diagnostic } from '../core/diagnostics.js';
import type { Interpretation } from '../core/interpretation.js';
import { OBSERVED_REASONS, type ObservedSnapshot } from '../core/observed.js';
import { PERSISTED_RELATION_TYPES, type ResolvedSnapshot } from '../core/resolved.js';
import { MAX_ARTIFACT_BYTES } from '../limits.js';
import { checkSymlinkAncestors, readTextFileGuarded } from '../util/fs.js';
import {
  InvalidSnapshotError,
  UnsupportedSchemaVersionError,
  deserializeSnapshot,
  serializeSnapshot,
  type VersionedSnapshot,
} from './serialization.js';

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
const NATIVE_ORIGIN_VALUES: readonly string[] = [
  'project',
  'user',
  'managed',
  'plugin',
  'builtin',
  'unknown',
];
const INSPECTABILITY_VALUES: readonly string[] = ['observable', 'known-runtime-provided', 'opaque'];
const OBSERVED_STATUS_VALUES: readonly string[] = [
  'observed',
  'unreadable',
  'unsupported',
  'skipped',
  'unknown',
];
const DIAGNOSTIC_SEVERITY_VALUES: readonly string[] = ['info', 'warning', 'error'];
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
  /**
   * The stored interpretation's id, when one was written with the run. A run
   * captured before v1.0 has none, and its interpretation is recomputed on read
   * (roadmap #84). Retention reclaims a run as a unit, so the three ids travel
   * together (#87).
   */
  interpretationId: string | null;
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
  /** The stored interpretation id, absent on a pointer written before v1.0. */
  interpretation?: string;
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
    pflHome(home),
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
  return readArtifact(
    artifactPath(snapshotsDir(projectId, home), snapshotId),
    isResolvedSnapshot,
    pflHome(home),
  );
}

/**
 * Reads the Derived Interpretation stored for a resolved snapshot, or `null`
 * when none is stored. The artifact is keyed by the resolved snapshot id, so
 * the mapping from a run to its interpretation is a path, not a scan: a
 * corrupt artifact cannot be mistaken for a different run's, and its failure is
 * attributable to this run. A pre-v1.0 run carries none, and that absence is
 * not an error (roadmap #84); every other failure throws.
 */
export async function readInterpretationForResolved(
  projectId: string,
  resolvedSnapshotId: string,
  home: string = homedir(),
): Promise<Interpretation | null> {
  const interpretation = await readArtifactIfPresent(
    artifactPath(interpretationsDir(projectId, home), resolvedSnapshotId),
    isInterpretation,
    pflHome(home),
  );
  if (interpretation !== null && interpretation.resolvedSnapshotId !== resolvedSnapshotId) {
    // The file is named for one resolved snapshot but claims another: the store
    // is inconsistent, so fail closed rather than guess which is right.
    throw invalidArtifactError(
      `interpretation ${interpretation.interpretationId} is stored under ${resolvedSnapshotId} but claims ${interpretation.resolvedSnapshotId}`,
      resolvedSnapshotId,
    );
  }
  return interpretation;
}

/**
 * Persists a Derived Interpretation (design doc §21, roadmap #84). An
 * interpretation is a run artifact like the observed and resolved snapshots, so
 * `inspect` writes it once and read commands use the stored copy; a report then
 * reproduces, and it can state which classifier produced it. It is stored under
 * its resolved snapshot id, which is unique per run, so immutability holds.
 */
export async function writeInterpretation(
  projectId: string,
  interpretation: Interpretation,
  home: string = homedir(),
): Promise<void> {
  await writeArtifact(
    artifactPath(interpretationsDir(projectId, home), interpretation.resolvedSnapshotId),
    serializeSnapshot(interpretation),
  );
}

/** The default for read commands: no `--snapshot` means `latest` (design doc §23). */
export async function readLatestPointer(
  projectId: string,
  home: string = homedir(),
): Promise<LatestPointer | null> {
  const read = await readTextFileGuarded(
    latestPath(projectId, home),
    MAX_ARTIFACT_BYTES,
    pflHome(home),
  );
  if (read.status === 'missing') return null;
  if (read.status !== 'ok') {
    throw snapshotStoreError(guardedReadError(read, 'the latest pointer'));
  }
  const text = read.text;

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
  // Optional: a pointer written before v1.0 has no interpretation id.
  const interpretation = parsed['interpretation'];
  if (interpretation !== undefined && typeof interpretation !== 'string') {
    throw snapshotStoreError('the latest pointer has an invalid interpretation id');
  }
  return {
    observed,
    resolved,
    ...(interpretation !== undefined ? { interpretation } : {}),
  };
}

/** Points `latest` at a run. The pointer is mutable and replaced atomically. */
export async function writeLatestPointer(
  projectId: string,
  pointer: LatestPointer,
  home: string = homedir(),
): Promise<void> {
  assertSafeSegment(pointer.observed, 'snapshot id');
  assertSafeSegment(pointer.resolved, 'snapshot id');
  if (pointer.interpretation !== undefined) {
    assertSafeSegment(pointer.interpretation, 'interpretation id');
  }

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
  for (const name of await artifactNames(resolvedDir, pflHome(home), diagnostics)) {
    try {
      const resolved = await readArtifact(
        join(resolvedDir, name),
        isResolvedSnapshot,
        pflHome(home),
      );
      resolvedByObserved.set(resolved.observedSnapshotId, resolved.snapshotId);
    } catch (error) {
      diagnostics.push(readErrorDiagnostic(error, 'unreadable-snapshot', name));
    }
  }

  // Interpretations are keyed by the resolved snapshot they interpret, so a run
  // summary can name the stored interpretation (or `null` when there is none).
  const interpretationByResolved = new Map<string, string>();
  for (const name of await artifactNames(
    interpretationsDir(projectId, home),
    pflHome(home),
    diagnostics,
  )) {
    try {
      const interpretation = await readArtifact(
        join(interpretationsDir(projectId, home), name),
        isInterpretation,
        pflHome(home),
      );
      const keyedAs = name.slice(0, -ARTIFACT_SUFFIX.length);
      // The artifact is keyed by the resolved snapshot id, so the file name and
      // the payload must agree. A mismatch is the same inconsistency a direct
      // read refuses, and the scan must not report a run as interpreted when
      // the read path would not find it.
      if (interpretation.resolvedSnapshotId !== keyedAs) {
        diagnostics.push({
          severity: 'warning',
          code: 'invalid-snapshot',
          message: `interpretation ${interpretation.interpretationId} is stored under ${keyedAs} but claims ${interpretation.resolvedSnapshotId}`,
          path: name,
        });
        continue;
      }
      interpretationByResolved.set(
        interpretation.resolvedSnapshotId,
        interpretation.interpretationId,
      );
    } catch (error) {
      diagnostics.push(readErrorDiagnostic(error, 'unreadable-interpretation', name));
    }
  }

  const runs: StoredRunSummary[] = [];
  for (const name of await artifactNames(observedDir, pflHome(home), diagnostics)) {
    try {
      const observed = await readArtifact(
        join(observedDir, name),
        isObservedSnapshot,
        pflHome(home),
      );
      const resolvedId = resolvedByObserved.get(observed.snapshotId) ?? null;
      runs.push({
        observedId: observed.snapshotId,
        resolvedId,
        interpretationId:
          resolvedId === null ? null : (interpretationByResolved.get(resolvedId) ?? null),
        capturedAt: observed.capturedAt,
        runtime: { id: observed.runtime.id, version: observed.runtime.version },
        completeness: observed.completeness,
      });
    } catch (error) {
      diagnostics.push(readErrorDiagnostic(error, 'unreadable-observation', name));
    }
  }

  runs.sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : 0));
  return { runs, diagnostics };
}

async function artifactNames(
  dir: string,
  baseDir: string,
  diagnostics: Diagnostic[],
): Promise<string[]> {
  if ((await checkSymlinkAncestors(baseDir, dir)) !== 'ok') {
    diagnostics.push({
      severity: 'error',
      code: 'snapshot-store-unreadable',
      message: `snapshot store path is reached through a symlink: ${dir}`,
      path: dir,
    });
    return [];
  }
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
  baseDir: string,
): Promise<T> {
  const read = await readTextFileGuarded(target, MAX_ARTIFACT_BYTES, baseDir);
  if (read.status === 'missing')
    throw snapshotStoreError(`snapshot not found: ${basename(target)}`);
  if (read.status !== 'ok') {
    throw snapshotStoreError(guardedReadError(read, `snapshot ${basename(target)}`));
  }
  return parseArtifact(read.text, target, isValid);
}

/**
 * Like `readArtifact`, but a missing artifact is `null` rather than an error.
 * Used for an optional companion artifact (a pre-v1.0 run has no stored
 * interpretation) where absence is normal but any other failure is not.
 */
async function readArtifactIfPresent<T>(
  target: string,
  isValid: (value: unknown) => value is T,
  baseDir: string,
): Promise<T | null> {
  const read = await readTextFileGuarded(target, MAX_ARTIFACT_BYTES, baseDir);
  if (read.status === 'missing') return null;
  if (read.status !== 'ok') {
    throw snapshotStoreError(guardedReadError(read, `snapshot ${basename(target)}`));
  }
  return parseArtifact(read.text, target, isValid);
}

function parseArtifact<T>(
  text: string,
  target: string,
  isValid: (value: unknown) => value is T,
): T {
  let parsed: unknown;
  try {
    // The on-disk envelope always carries `schemaVersion` (ADR 0001), including
    // for Interpretation.
    parsed = deserializeSnapshot<VersionedSnapshot>(text);
  } catch (error) {
    // A snapshot this binary cannot interpret is a diagnostic, not a store
    // failure (ADR 0001, roadmap #82): the store is readable, the artifact is
    // not. `listRuns` and every read command handle it the same way.
    throw uninterpretableArtifact(error, basename(target));
  }

  if (!isValid(parsed)) {
    // A well-formed envelope whose contents are the wrong shape is as
    // uninterpretable as malformed JSON: same diagnostic, same exit (#82).
    const message = `snapshot is missing required fields: ${basename(target)}`;
    throw invalidArtifactError(message, basename(target));
  }
  return parsed;
}

/** A store error for a read the guard refused, naming what was refused. */
function guardedReadError(
  read: Exclude<Awaited<ReturnType<typeof readTextFileGuarded>>, { status: 'ok' | 'missing' }>,
  label: string,
): string {
  switch (read.status) {
    case 'symlink':
      return `${label} is a symlink and was not followed`;
    case 'hardlink':
      return `${label} is a hardlink and was not followed`;
    case 'not-regular':
      return `${label} is not a regular file`;
    case 'too-large':
      return `${label} exceeds the artifact size limit (${read.maxBytes} bytes)`;
    case 'unreadable':
      return `${label} could not be read`;
  }
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
  if (
    !Array.isArray(value['elements']) ||
    !value['elements'].every(isObservedElement) ||
    !Array.isArray(value['diagnostics']) ||
    !value['diagnostics'].every(isDiagnostic)
  ) {
    return false;
  }
  const completeness = value['completeness'];
  if (typeof completeness !== 'string' || !COMPLETENESS_VALUES.includes(completeness)) return false;
  const digests = value['digests'];
  return isRecord(digests) && typeof digests['observed'] === 'string';
}

/**
 * Validates an observed element's contents, the way `isResolvedElement`
 * validates a resolved one (roadmap S11). A snapshot whose elements are the
 * wrong shape is refused rather than handed to the reader as a valid capture.
 */
function isObservedElement(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value['id'] !== 'string') return false;

  const native = value['native'];
  if (!isRecord(native) || typeof native['kind'] !== 'string') return false;
  if (typeof native['origin'] !== 'string' || !NATIVE_ORIGIN_VALUES.includes(native['origin'])) {
    return false;
  }
  const scope = native['scope'];
  if (!(scope === null || typeof scope === 'string')) return false;

  if (
    typeof value['inspectability'] !== 'string' ||
    !INSPECTABILITY_VALUES.includes(value['inspectability'])
  ) {
    return false;
  }
  if (!isRecord(value['metadata'])) return false;
  if (typeof value['status'] !== 'string' || !OBSERVED_STATUS_VALUES.includes(value['status'])) {
    return false;
  }
  const reason = value['reason'];
  if (reason !== undefined) {
    if (typeof reason !== 'string' || !(OBSERVED_REASONS as readonly string[]).includes(reason)) {
      return false;
    }
  }
  // A non-`observed` element must say why (design doc §10.2, §10.3); assembly
  // enforces it, so a stored snapshot that omits it is malformed.
  if (value['status'] !== 'observed' && reason === undefined) return false;
  return isObservedSource(value['source']);
}

function isObservedSource(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value['path'] !== undefined && typeof value['path'] !== 'string') return false;
  if (value['digest'] !== undefined && typeof value['digest'] !== 'string') return false;
  if (value['sizeBytes'] !== undefined && typeof value['sizeBytes'] !== 'number') return false;
  if (value['symlink'] !== undefined && typeof value['symlink'] !== 'boolean') return false;
  return true;
}

function isDiagnostic(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    typeof value['severity'] !== 'string' ||
    !DIAGNOSTIC_SEVERITY_VALUES.includes(value['severity'])
  ) {
    return false;
  }
  if (typeof value['code'] !== 'string' || typeof value['message'] !== 'string') return false;
  if (value['path'] !== undefined && typeof value['path'] !== 'string') return false;
  return true;
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
  // Validated against the full schema-1 set, not only the produced set, so a
  // stored artifact the previous reader accepted stays readable (#83).
  return (
    typeof type === 'string' &&
    PERSISTED_RELATION_TYPES.includes(type) &&
    typeof value['from'] === 'string' &&
    typeof value['to'] === 'string'
  );
}

function isInterpretation(value: unknown): value is Interpretation {
  if (!isRecord(value)) return false;
  return (
    typeof value['schemaVersion'] === 'string' &&
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

/**
 * A snapshot whose schema this binary does not support, or which is malformed,
 * is not a store failure: the store read succeeded and the artifact is the
 * problem. It becomes a configuration error carrying a diagnostic that names
 * the version found and the versions supported, so a read command degrades to a
 * diagnostic instead of a bare exit 6 (ADR 0001; roadmap #82).
 */
function uninterpretableArtifact(error: unknown, name: string): PflError {
  if (error instanceof UnsupportedSchemaVersionError) {
    return new PflError(error.message, EXIT_CODES.CONFIG_ERROR, {
      diagnostics: [
        {
          severity: 'warning',
          code: 'unsupported-snapshot-schema',
          message: error.message,
          path: name,
        },
      ],
    });
  }
  if (error instanceof InvalidSnapshotError) {
    return invalidArtifactError(error.message, name);
  }
  return snapshotStoreError(errorMessage(error));
}

function invalidArtifactError(message: string, name: string): PflError {
  return new PflError(message, EXIT_CODES.CONFIG_ERROR, {
    diagnostics: [{ severity: 'warning', code: 'invalid-snapshot', message, path: name }],
  });
}

/** The diagnostic for one artifact a scan could not read, carried or generic. */
function readErrorDiagnostic(error: unknown, fallbackCode: string, name: string): Diagnostic {
  const carried = error instanceof PflError ? error.data?.diagnostics?.[0] : undefined;
  if (carried !== undefined) return { ...carried, path: name };
  return { severity: 'warning', code: fallbackCode, message: errorMessage(error), path: name };
}
