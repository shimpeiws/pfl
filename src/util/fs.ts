import { access, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

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
  return realChild === realParent || realChild.startsWith(`${realParent}/`);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Directory entry names, or an empty list when the directory cannot be read. */
export async function readDirectoryNames(path: string): Promise<string[]> {
  return readdir(path).catch(() => []);
}
