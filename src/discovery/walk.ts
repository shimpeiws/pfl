import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Diagnostic } from '../core/diagnostics.js';
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
}

export interface WalkResult {
  entries: DiscoveredPath[];
  diagnostics: Diagnostic[];
}

/**
 * Walks known runtime search areas read-only, recording symlinks instead of
 * following them. Unknown items inside a known area are preserved, not silently
 * ignored (design doc §10.2). The walker never roams beyond the given subpaths,
 * never follows a symlink, and never aborts on an unreadable entry — it records
 * a diagnostic and continues (design doc §18).
 */
export async function walkHarnessPaths(
  root: string,
  subpaths: readonly string[],
): Promise<WalkResult> {
  const entries = new Map<string, DiscoveredPath>();
  const diagnostics: Diagnostic[] = [];
  const canonicalRoot = resolve(root);

  for (const subpath of subpaths) {
    const target = resolveSubpath(canonicalRoot, subpath);
    if (target === null) {
      diagnostics.push({
        severity: 'error',
        code: 'path-outside-root',
        message: `search area escapes the project root: ${subpath}`,
        path: subpath,
      });
      continue;
    }

    const entry = await lstat(target).catch(() => null);
    if (entry === null) {
      diagnostics.push({
        severity: 'info',
        code: 'path-not-found',
        message: `search area does not exist: ${subpath}`,
        path: subpath,
      });
      continue;
    }

    const relativePath = toRelative(canonicalRoot, target);
    if (!(await staysWithinRoot(canonicalRoot, target, entry.isSymbolicLink()))) {
      diagnostics.push(outsideRoot(relativePath));
      continue;
    }

    if (entry.isSymbolicLink()) {
      record(entries, { relativePath, kind: 'symlink' });
    } else if (entry.isDirectory()) {
      record(entries, { relativePath, kind: 'directory' });
      await walkDirectory(canonicalRoot, target, entries, diagnostics);
    } else if (entry.isFile()) {
      record(entries, await fileEntry(canonicalRoot, target, diagnostics));
    } else {
      diagnostics.push(unsupportedEntry(relativePath));
      record(entries, { relativePath, kind: 'unknown' });
    }
  }

  return { entries: [...entries.values()].sort(byRelativePath), diagnostics };
}

async function walkDirectory(
  root: string,
  dir: string,
  entries: Map<string, DiscoveredPath>,
  diagnostics: Diagnostic[],
): Promise<void> {
  const dirents = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (dirents === null) {
    const relativePath = toRelative(root, dir);
    diagnostics.push({
      severity: 'warning',
      code: 'unreadable-directory',
      message: `could not read directory: ${relativePath}`,
      path: relativePath,
    });
    return;
  }

  for (const dirent of dirents) {
    const full = join(dir, dirent.name);
    const relativePath = toRelative(root, full);

    if (!(await staysWithinRoot(root, full, dirent.isSymbolicLink()))) {
      diagnostics.push(outsideRoot(relativePath));
      continue;
    }

    if (dirent.isSymbolicLink()) {
      record(entries, { relativePath, kind: 'symlink' });
      continue;
    }

    if (dirent.isDirectory()) {
      record(entries, { relativePath, kind: 'directory' });
      await walkDirectory(root, full, entries, diagnostics);
    } else if (dirent.isFile()) {
      record(entries, await fileEntry(root, full, diagnostics));
    } else {
      diagnostics.push(unsupportedEntry(relativePath));
      record(entries, { relativePath, kind: 'unknown' });
    }
  }
}

async function fileEntry(
  root: string,
  full: string,
  diagnostics: Diagnostic[],
): Promise<DiscoveredPath> {
  const relativePath = toRelative(root, full);
  try {
    const content = await readFile(full);
    return { relativePath, kind: 'file', digest: sha256Digest(content), sizeBytes: content.length };
  } catch {
    diagnostics.push({
      severity: 'warning',
      code: 'unreadable-file',
      message: `could not read file: ${relativePath}`,
      path: relativePath,
    });
    return { relativePath, kind: 'file' };
  }
}

function record(entries: Map<string, DiscoveredPath>, entry: DiscoveredPath): void {
  if (!entries.has(entry.relativePath)) {
    entries.set(entry.relativePath, entry);
  }
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

function unsupportedEntry(path: string): Diagnostic {
  return {
    severity: 'warning',
    code: 'unsupported-entry',
    message: `unsupported filesystem entry: ${path}`,
    path,
  };
}
