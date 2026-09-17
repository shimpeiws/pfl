import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { EXIT_CODES, PflError } from '../cli/exit-codes.js';
import type { Diagnostic } from '../core/diagnostics.js';
import { pathDerivedProjectId, rootScopedProjectId } from '../discovery/project-identity.js';
import { MAX_ARTIFACT_BYTES } from '../limits.js';
import type { ProjectContext } from '../runtime/types.js';
import { readTextFileGuarded } from '../util/fs.js';
import { isSafeSegment, pflHome, projectDir } from './store.js';

/**
 * The project index (roadmap M8, issue #86). It maps a canonical project root to
 * the project id its snapshots live under, so the id is assigned once and does
 * not move when a git remote is added, changed, or removed.
 *
 * The index is **store metadata, not a snapshot**: it is mutable by design and
 * carries its own version, outside `SNAPSHOT_SCHEMA_VERSION`, which continues to
 * govern the immutable artifacts alone. Introducing it therefore does not bump
 * the snapshot schema and does not make a v0.1 snapshot unreadable — those
 * snapshots are what it exists to adopt.
 */

export const PROJECT_INDEX_VERSION = '1';

const INDEX_FILE = 'index.json';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Root (canonical) to project id. */
export interface ProjectIndex {
  indexVersion: string;
  projects: Record<string, string>;
}

export function projectIndexPath(home: string = homedir()): string {
  return join(pflHome(home), INDEX_FILE);
}

export interface ResolvedProjectId {
  id: string;
  /** What happened, when adopting or declining a legacy history. */
  diagnostics: Diagnostic[];
}

export interface ResolveProjectIdOptions {
  /**
   * Whether the index may be written. Read-only commands pass `false` so a read
   * does not mutate the store; the id they compute is the same one a later
   * `inspect` would persist.
   */
  write?: boolean;
}

/**
 * Resolves the stored project id for a context, consulting the index first and
 * minting an id only when the root is unseen. A history written by v0.1 (before
 * the index) is adopted rather than abandoned, exclusively, so two clones of one
 * remote do not both claim the same shared legacy directory.
 */
export async function resolveStoredProjectId(
  context: ProjectContext,
  home: string = homedir(),
  options: ResolveProjectIdOptions = {},
): Promise<ResolvedProjectId> {
  const index = await readProjectIndex(home);
  const existing = index.projects[context.root];
  if (existing !== undefined) return { id: existing, diagnostics: [] };

  const diagnostics: Diagnostic[] = [];
  const claimed = (id: string): boolean =>
    Object.entries(index.projects).some(([root, value]) => value === id && root !== context.root);

  // Both the remote-derived (v0.1 git) and path-derived directories may exist
  // for this root. Prefer the one whose `latest` is more recent and leave the
  // other unclaimed; `pfl gc` reports it as unreferenced (it is never deleted
  // automatically, because an unclaimed root is unknown).
  const candidates: string[] = [];
  if (await isDirectory(projectDir(context.id, home))) candidates.push(context.id);
  const pathId = pathDerivedProjectId(context.root);
  if (pathId !== context.id && (await isDirectory(projectDir(pathId, home)))) {
    candidates.push(pathId);
  }

  let chosen = context.id;
  if (candidates.length === 1) {
    [chosen] = candidates as [string];
  } else if (candidates.length > 1) {
    chosen = await mostRecentLatest(candidates, home);
  }

  if (claimed(chosen)) {
    // The legacy id is shared by every clone of one remote; another root got
    // here first. Start this root's own history and say where the shared one is.
    const shared = chosen;
    chosen = rootScopedProjectId(context);
    diagnostics.push({
      severity: 'warning',
      code: 'shared-legacy-history',
      message: `a shared legacy history exists at ${projectDir(shared, home)} but is claimed by another root; starting a new history under ${chosen}`,
    });
  } else if (candidates.length > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'adopted-legacy-history',
      message: `adopted the existing history under ${chosen}`,
    });
  }

  if (options.write !== false) {
    // Re-read before writing: two projects indexed concurrently would otherwise
    // lose each other's entry to last-write-wins, and two unseen clones could
    // both claim the same legacy id. If a fresh read shows another root took it,
    // fall back to this root's own id. A lock is still out of scope for #86.
    const fresh = await readProjectIndex(home);
    if (
      Object.entries(fresh.projects).some(([root, id]) => id === chosen && root !== context.root)
    ) {
      chosen = rootScopedProjectId(context);
      diagnostics.push({
        severity: 'warning',
        code: 'shared-legacy-history',
        message: `another root claimed the shared legacy history concurrently; starting a new history under ${chosen}`,
      });
    }
    fresh.projects[context.root] = chosen;
    await writeProjectIndex(fresh, home);
  }
  return { id: chosen, diagnostics };
}

export async function readProjectIndex(home: string = homedir()): Promise<ProjectIndex> {
  const read = await readTextFileGuarded(projectIndexPath(home), MAX_ARTIFACT_BYTES, pflHome(home));
  if (read.status === 'missing') return { indexVersion: PROJECT_INDEX_VERSION, projects: {} };
  if (read.status !== 'ok') {
    throw indexError(`the project index could not be read (${read.status})`, home);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    throw indexError('the project index is not valid JSON', home);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw indexError('the project index is not a JSON object', home);
  }
  const { indexVersion, projects } = parsed as {
    indexVersion?: unknown;
    projects?: unknown;
  };
  if (typeof indexVersion !== 'string' || indexVersion !== PROJECT_INDEX_VERSION) {
    throw indexError(`unsupported project index version: ${String(indexVersion)}`, home);
  }
  if (typeof projects !== 'object' || projects === null || Array.isArray(projects)) {
    throw indexError('the project index has no projects map', home);
  }
  const entries: Record<string, string> = {};
  for (const [root, id] of Object.entries(projects)) {
    // An id becomes a path segment under `projects/`; refuse a value that could
    // escape it rather than let a later command delete outside the store.
    if (typeof id !== 'string' || !isSafeSegment(id)) {
      throw indexError('the project index has an invalid project id', home);
    }
    // Roots are canonical absolute paths; a relative one would be resolved
    // against the working directory and could misclassify an orphan.
    if (!root.startsWith('/')) {
      throw indexError('the project index has a non-absolute project root', home);
    }
    entries[root] = id;
  }
  return { indexVersion, projects: entries };
}

/** Writes the index atomically; it is the one mutable store document besides `latest`. */
export async function writeProjectIndex(
  index: ProjectIndex,
  home: string = homedir(),
): Promise<void> {
  const target = projectIndexPath(home);
  await mkdir(dirname(target), { recursive: true, mode: DIR_MODE });
  await chmod(dirname(target), DIR_MODE).catch(() => undefined);
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    // Open, write, and fsync before the rename: without the sync a crash can
    // leave the rename pointing at an empty file, bricking every command.
    const handle = await open(temp, 'w', FILE_MODE);
    try {
      await handle.writeFile(`${JSON.stringify(index)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temp, FILE_MODE);
    await rename(temp, target);
  } catch (error) {
    throw indexError(`could not write the project index: ${errorMessage(error)}`, home);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function isDirectory(path: string): Promise<boolean> {
  // `lstat`: a symlinked project directory is not an existing history and is
  // never followed.
  const entry = await lstat(path).catch(() => null);
  return entry?.isDirectory() === true;
}

async function mostRecentLatest(ids: string[], home: string): Promise<string> {
  let best = ids[0] as string;
  let bestTime = -1;
  for (const id of ids) {
    // `lstat`: a symlinked `latest` is not followed; only its own mtime counts.
    const time = await lstat(join(projectDir(id, home), 'latest'))
      .then((value) => value.mtimeMs)
      .catch(() => -1);
    if (time > bestTime) {
      bestTime = time;
      best = id;
    }
  }
  return best;
}

function indexError(message: string, _home: string): PflError {
  // A home-relative display path, so the message names no account even before
  // it passes the export redaction.
  return new PflError(
    `${message}: ${join('~/.pfl', INDEX_FILE)} (move it aside to rebuild the index)`,
    EXIT_CODES.SNAPSHOT_STORE_FAILED,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
