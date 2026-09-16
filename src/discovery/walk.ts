import type { Dir } from 'node:fs';
import { lstat, opendir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Diagnostic } from '../core/diagnostics.js';
import {
  MAX_FILE_BYTES,
  MAX_WALK_DEPTH,
  MAX_WALK_ENTRIES,
  limitExceededDiagnostic,
} from '../limits.js';
import { isPathWithin } from '../util/fs.js';
import { sha256Digest } from '../util/hash.js';

/**
 * A discovered filesystem entry. Symlinks are recorded but never followed
 * (design doc §10.3); they surface as `kind: 'symlink'` and are reported as
 * skipped by the caller. `kind: 'unknown'` preserves a non-file, non-directory,
 * non-symlink entry (a socket, FIFO, …) instead of dropping it silently.
 */
export interface DiscoveredPath {
  /** Path relative to the walk root. */
  relativePath: string;
  kind: 'file' | 'directory' | 'symlink' | 'unknown';
  /** `sha256:` digest of the file contents, when the file could be read. */
  digest?: string;
  sizeBytes?: number;
  /**
   * A regular file the walk refused to read: an inode reachable from outside
   * the root (`nlink > 1`, roadmap S3) or one over the per-file byte ceiling
   * (roadmap S7). The caller records it as skipped.
   */
  skipReason?: WalkSkipReason;
}

export type WalkSkipReason = 'hardlink-not-followed' | 'file-too-large';

export interface WalkResult {
  entries: DiscoveredPath[];
  diagnostics: Diagnostic[];
}

interface WalkState {
  root: string;
  entries: Map<string, DiscoveredPath>;
  diagnostics: Diagnostic[];
  /** Entries examined so far, across every subpath, against `MAX_WALK_ENTRIES`. */
  walked: number;
  /** Set once the entry ceiling is hit, so the walk stops instead of roaming. */
  entryLimitHit: boolean;
}

/**
 * Walks known runtime search areas read-only, recording symlinks instead of
 * following them. Unknown items inside a known area are preserved, not silently
 * ignored (design doc §10.2). The walker never roams beyond the given subpaths,
 * never follows a symlink, never opens a non-regular file, and never aborts on
 * an unreadable entry — it records a diagnostic and continues (design doc §18).
 *
 * Hardlinks (`nlink > 1`) are refused because their inode is reachable from
 * outside the walked root, and resource ceilings bound the bytes read, the
 * number of entries, and the recursion depth (roadmap S3, S7).
 */
export async function walkHarnessPaths(
  root: string,
  subpaths: readonly string[],
): Promise<WalkResult> {
  const state: WalkState = {
    root: resolve(root),
    entries: new Map(),
    diagnostics: [],
    walked: 0,
    entryLimitHit: false,
  };

  for (const subpath of subpaths) {
    if (state.entryLimitHit) break;
    const target = resolveSubpath(state.root, subpath);
    if (target === null) {
      state.diagnostics.push({
        severity: 'error',
        code: 'path-outside-root',
        message: `search area escapes the project root: ${subpath}`,
        path: subpath,
      });
      continue;
    }

    const entry = await lstat(target).catch(() => null);
    if (entry === null) {
      state.diagnostics.push({
        severity: 'info',
        code: 'path-not-found',
        message: `search area does not exist: ${subpath}`,
        path: subpath,
      });
      continue;
    }

    const relativePath = toRelative(state.root, target);
    if (!(await staysWithinRoot(state.root, target, entry.isSymbolicLink()))) {
      state.diagnostics.push(outsideRoot(relativePath));
      continue;
    }
    if (!consumeBudget(state, relativePath)) break;

    if (entry.isSymbolicLink()) {
      record(state, { relativePath, kind: 'symlink' });
    } else if (entry.isDirectory()) {
      record(state, { relativePath, kind: 'directory' });
      await walkDirectory(state, target, 0);
    } else if (entry.isFile()) {
      record(state, await fileEntry(state, target));
    } else {
      state.diagnostics.push(nonRegularFile(relativePath));
      record(state, { relativePath, kind: 'unknown' });
    }
  }

  return {
    entries: [...state.entries.values()].sort(byRelativePath),
    diagnostics: state.diagnostics,
  };
}

async function walkDirectory(state: WalkState, dir: string, depth: number): Promise<void> {
  if (depth >= MAX_WALK_DEPTH) {
    state.diagnostics.push(
      limitExceededDiagnostic('MAX_WALK_DEPTH', MAX_WALK_DEPTH, toRelative(state.root, dir)),
    );
    return;
  }

  // Streamed with `opendir`, not `readdir`: a hostile directory with millions of
  // entries must not be materialized as an array before the entry ceiling can
  // stop the walk (roadmap S7).
  let handle: Dir;
  try {
    handle = await opendir(dir);
  } catch {
    const relativePath = toRelative(state.root, dir);
    state.diagnostics.push({
      severity: 'warning',
      code: 'unreadable-directory',
      message: `could not read directory: ${relativePath}`,
      path: relativePath,
    });
    return;
  }

  try {
    for await (const dirent of handle) {
      if (state.entryLimitHit) return;
      const full = join(dir, dirent.name);
      const relativePath = toRelative(state.root, full);
      // Charge the budget before any further work (containment realpath, lstat,
      // read), so the ceiling bounds the work done, not just what is recorded.
      if (!consumeBudget(state, relativePath)) return;

      if (!(await staysWithinRoot(state.root, full, dirent.isSymbolicLink()))) {
        state.diagnostics.push(outsideRoot(relativePath));
        continue;
      }

      if (dirent.isSymbolicLink()) {
        record(state, { relativePath, kind: 'symlink' });
        continue;
      }

      if (dirent.isDirectory()) {
        record(state, { relativePath, kind: 'directory' });
        await walkDirectory(state, full, depth + 1);
      } else if (dirent.isFile()) {
        record(state, await fileEntry(state, full));
      } else {
        state.diagnostics.push(nonRegularFile(relativePath));
        record(state, { relativePath, kind: 'unknown' });
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function fileEntry(state: WalkState, full: string): Promise<DiscoveredPath> {
  const relativePath = toRelative(state.root, full);

  const entry = await lstat(full).catch(() => null);
  if (entry === null) {
    state.diagnostics.push(unreadableFile(relativePath));
    return { relativePath, kind: 'file' };
  }
  // The type is re-read from `lstat` rather than trusted from the directory
  // entry, so a file swapped for a link between the two is not followed
  // (roadmap S9: the residual TOCTOU is accepted; this narrows it).
  if (entry.isSymbolicLink()) return { relativePath, kind: 'symlink' };
  if (!entry.isFile()) {
    state.diagnostics.push(nonRegularFile(relativePath));
    return { relativePath, kind: 'unknown' };
  }
  if (entry.nlink > 1) {
    state.diagnostics.push({
      severity: 'warning',
      code: 'hardlink-not-followed',
      message: `hardlink not followed: ${relativePath}`,
      path: relativePath,
    });
    return {
      relativePath,
      kind: 'file',
      sizeBytes: entry.size,
      skipReason: 'hardlink-not-followed',
    };
  }
  if (entry.size > MAX_FILE_BYTES) {
    state.diagnostics.push(limitExceededDiagnostic('MAX_FILE_BYTES', MAX_FILE_BYTES, relativePath));
    return { relativePath, kind: 'file', sizeBytes: entry.size, skipReason: 'file-too-large' };
  }

  try {
    const content = await readFile(full);
    return { relativePath, kind: 'file', digest: sha256Digest(content), sizeBytes: content.length };
  } catch {
    state.diagnostics.push(unreadableFile(relativePath));
    return { relativePath, kind: 'file' };
  }
}

function record(state: WalkState, entry: DiscoveredPath): void {
  if (!state.entries.has(entry.relativePath)) {
    state.entries.set(entry.relativePath, entry);
  }
}

/**
 * Charges one entry against `MAX_WALK_ENTRIES`. Returns false once the ceiling
 * is exceeded, after recording a single naming diagnostic, so the caller stops
 * before doing any further work on that entry.
 */
function consumeBudget(state: WalkState, relativePath: string): boolean {
  state.walked += 1;
  if (state.walked > MAX_WALK_ENTRIES) {
    if (!state.entryLimitHit) {
      state.entryLimitHit = true;
      state.diagnostics.push(
        limitExceededDiagnostic('MAX_WALK_ENTRIES', MAX_WALK_ENTRIES, relativePath),
      );
    }
    return false;
  }
  return true;
}

/**
 * Whether an entry stays under the walk root without following it. For a
 * symlink the parent directory is asserted instead — the link itself lives
 * under the root, but resolving it would read the target. `isPathWithin`
 * resolves symlinks, so a regular entry reached through a symlinked ancestor
 * (an intermediate component of a subpath) is correctly rejected.
 */
async function staysWithinRoot(root: string, full: string, isSymlink: boolean): Promise<boolean> {
  return isPathWithin(root, isSymlink ? dirname(full) : full);
}

function resolveSubpath(root: string, subpath: string): string | null {
  const resolved = resolve(root, subpath);
  const rel = relative(root, resolved);
  if (rel === '') return root;
  return rel.startsWith('..') || isAbsolute(rel) ? null : resolved;
}

function toRelative(root: string, full: string): string {
  const rel = relative(root, full);
  return rel === '' ? '.' : rel;
}

function byRelativePath(a: DiscoveredPath, b: DiscoveredPath): number {
  return a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0;
}

function outsideRoot(path: string): Diagnostic {
  return {
    severity: 'error',
    code: 'path-outside-root',
    message: `entry resolved outside the project root: ${path}`,
    path,
  };
}

function nonRegularFile(path: string): Diagnostic {
  return {
    severity: 'warning',
    code: 'non-regular-file',
    message: `not a regular file, not opened: ${path}`,
    path,
  };
}

function unreadableFile(path: string): Diagnostic {
  return {
    severity: 'warning',
    code: 'unreadable-file',
    message: `could not read file: ${path}`,
    path,
  };
}
