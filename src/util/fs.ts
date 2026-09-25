import type { Stats } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Resolves `path` as far as the filesystem actually allows (symlinks and
 * all), then appends whatever doesn't exist yet lexically. Plain
 * `realpath(path).catch(() => resolve(path))` is NOT safe when `path`
 * doesn't exist: it falls back to the fully-unresolved lexical path, so an
 * existing symlinked ancestor (e.g. macOS's `/var` -> `/private/var`) is
 * resolved on one side of a comparison and not the other, producing a false
 * negative.
 */
export async function realpathAsFarAsExists(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path; // reached the filesystem root
    return join(await realpathAsFarAsExists(parent), basename(path));
  }
}

/** Whether `child` is `parent` itself or nested inside it, resolving symlinks on both sides. */
export async function isPathWithin(parent: string, child: string): Promise<boolean> {
  const [realParent, realChild] = await Promise.all([
    realpathAsFarAsExists(resolve(parent)),
    realpathAsFarAsExists(resolve(child)),
  ]);
  // Compose the comparison with the path module rather than a hardcoded
  // separator (roadmap S12). Case is not decided here: `realpath` returns the
  // OS-resolved spelling of both sides, so a case-insensitive volume compares
  // equal because the filesystem says so, not because we lowercased anything.
  const rel = relative(realParent, realChild);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The result of checking the path components between a `baseDir` (exclusive)
 * and a `target` (inclusive). `outside-base` means the target is not under the
 * base directory, which is a caller error; callers **refuse** it rather than
 * reading, so a mis-specified base fails closed.
 */
export type AncestorCheck = 'ok' | 'symlink' | 'outside-base';

/**
 * Checks every path component between `baseDir` (exclusive) and `target`
 * (inclusive) for a symlink. `lstat` does not follow the final component, but
 * it *does* resolve intermediate components, so checking only the leaf would
 * read through a symlinked ancestor directory (`.claude -> /outside`).
 * `baseDir` itself is a prefix and is not checked (home/root resolution is not
 * harness traversal).
 */
export async function checkSymlinkAncestors(
  baseDir: string,
  target: string,
): Promise<AncestorCheck> {
  const base = resolve(baseDir);
  const rel = relative(base, resolve(target));
  if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return 'outside-base';

  let current = base;
  for (const component of rel.split(sep)) {
    if (component === '') continue;
    current = join(current, component);
    const entry = await lstat(current).catch(() => null);
    if (entry === null) return 'ok'; // missing; the caller reports it as absent
    if (entry.isSymbolicLink()) return 'symlink';
  }
  return 'ok';
}

/** How a fixed read target looks, before it is opened. */
export type TargetStatus = 'ok' | 'missing' | 'symlink' | 'not-regular' | 'hardlink' | 'unreadable';

export interface FileTarget {
  status: TargetStatus;
  sizeBytes?: number;
}

/**
 * Classifies a fixed read target without opening it. No component under
 * `baseDir` may be a symlink; a hardlinked regular file is refused because its
 * inode is reachable from elsewhere (roadmap S3); a non-regular file is never
 * opened. A target outside `baseDir` is refused.
 */
export async function inspectFileTarget(absPath: string, baseDir: string): Promise<FileTarget> {
  if ((await checkSymlinkAncestors(baseDir, absPath)) !== 'ok') return { status: 'symlink' };

  let entry: Stats;
  try {
    entry = await lstat(absPath);
  } catch (error) {
    return (error as { code?: string }).code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'unreadable' };
  }
  if (entry.isSymbolicLink()) return { status: 'symlink' };
  if (!entry.isFile()) return { status: 'not-regular' };
  if (entry.nlink > 1) return { status: 'hardlink' };
  return { status: 'ok', sizeBytes: entry.size };
}

/**
 * The outcome of a guarded text read. `pfl` never follows a symlink and never
 * opens a non-regular file, so the caller records why an element was skipped
 * instead of dropping it silently (design doc §10.3, §18).
 */
export type GuardedTextRead =
  | { status: 'ok'; text: string }
  | { status: 'missing' }
  | { status: 'symlink' }
  | { status: 'not-regular' }
  | { status: 'hardlink' }
  | { status: 'too-large'; sizeBytes: number; maxBytes: number }
  | { status: 'unreadable' };

/**
 * Reads a UTF-8 text file that may legitimately be absent, without following a
 * symlink. No component under `baseDir` may be a symlink; a non-regular file
 * (FIFO, socket, device) is never opened, so it cannot hang the run; a
 * hardlinked file is refused; and a file larger than `maxBytes` is refused
 * before it is read. `ENOENT` is `missing`; any other failure is `unreadable`.
 */
export async function readTextFileGuarded(
  absPath: string,
  maxBytes: number,
  baseDir: string,
): Promise<GuardedTextRead> {
  const target = await inspectFileTarget(absPath, baseDir);
  if (target.status !== 'ok') {
    return target.status === 'unreadable' ? { status: 'unreadable' } : { status: target.status };
  }
  if ((target.sizeBytes ?? 0) > maxBytes) {
    return { status: 'too-large', sizeBytes: target.sizeBytes ?? 0, maxBytes };
  }
  try {
    return { status: 'ok', text: await readFile(absPath, 'utf8') };
  } catch {
    return { status: 'unreadable' };
  }
}

/**
 * Whether `path` exists, without following a symlink at any component between
 * `baseDir` (exclusive) and the target (inclusive). A symlinked component, or a
 * symlinked leaf, counts as absent.
 */
export async function pathExists(baseDir: string, path: string): Promise<boolean> {
  if ((await checkSymlinkAncestors(baseDir, path)) !== 'ok') return false;
  const entry = await lstat(path).catch(() => null);
  return entry !== null && !entry.isSymbolicLink();
}

/**
 * Directory entry names, or an empty list when `path` is missing, is not a real
 * directory, or is reached through a symlink. Non-following at every component
 * under `baseDir`, so neither a symlinked install directory nor a symlinked
 * ancestor is traversed (ADR 0002 §1).
 */
export async function readDirectoryNames(baseDir: string, path: string): Promise<string[]> {
  if ((await checkSymlinkAncestors(baseDir, path)) !== 'ok') return [];
  const entry = await lstat(path).catch(() => null);
  if (entry === null || !entry.isDirectory()) return [];
  return readdir(path).catch(() => []);
}
