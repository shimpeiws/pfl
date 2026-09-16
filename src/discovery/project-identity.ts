import { lstat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { ProjectContext } from '../runtime/types.js';
import { MAX_PARSE_BYTES } from '../limits.js';
import { readTextFileGuarded, realpathAsFarAsExists } from '../util/fs.js';
import { sha256Digest } from '../util/hash.js';

/**
 * Project identity (design doc §16, §29).
 *
 * For a Git repository with a remote, identity comes from the canonical remote
 * URL *alone*, so the same repository cloned to a different path, checked out as
 * a worktree, or moved keeps one `projectId` and shares its snapshots. This is
 * what the issue's "same repo cloned to two different paths yields the same id"
 * check requires; including the root path would defeat it.
 *
 * A Git repository without a remote, and a non-Git directory, fall back to the
 * canonical absolute path.
 *
 * Discovery is static: it walks up for `.git`, reads `.git/config` and, for a
 * linked worktree, the `gitdir`/`commondir` files. It never shells out to `git`
 * and never runs a hook.
 *
 * `.git` is found with `lstat`, so a symlinked `.git` is never followed.
 * `gitdir`/`commondir` are treated as an explicitly allowed Git-metadata scope:
 * a linked worktree's common dir legitimately lives outside the worktree, so
 * containment cannot be required. Only `config` is read from the resolved dir,
 * and nothing but `remote.*.url` is taken from it.
 *
 * Consent boundary (roadmap S5, ADR 0002 §2). A `.git` **directory** at the
 * project root, and its own `config`, are project-local and read implicitly. A
 * `.git` **file**'s `gitdir:` target and any ancestor `.git` above the root are
 * out-of-project reads: they are followed only when `allowExternalGit` is set,
 * which callers derive from resolved consent. Before consent, a linked worktree
 * or a run from a subdirectory falls back to the canonical path, and M8's root
 * index is what later reclaims a snapshot written under that path-derived id.
 */

/** Where `.git` and the remote configuration live for a discovered repository. */
interface GitLocation {
  /** Directory containing the `.git` entry — the canonical repository root. */
  root: string;
  /** Directory holding `config` (the common dir for a linked worktree). */
  configDir: string;
}

export interface ProjectContextOptions {
  /**
   * Whether out-of-project Git metadata may be read: a `.git` **file**'s
   * `gitdir:` target and an ancestor `.git` above the project root. Defaults to
   * `false` (fail closed); callers set it from resolved consent.
   */
  allowExternalGit?: boolean;
}

export async function resolveProjectContext(
  cwd: string,
  options: ProjectContextOptions = {},
): Promise<ProjectContext> {
  const allowExternalGit = options.allowExternalGit ?? false;
  const canonicalCwd = await realpathAsFarAsExists(resolve(cwd));

  const git = await findGitLocation(canonicalCwd, allowExternalGit);
  if (git) {
    const canonicalRoot = await realpathAsFarAsExists(git.root);
    const remote = await readRemoteUrl(git);
    if (remote) {
      const normalized = normalizeRemoteUrl(remote);
      return {
        id: hashedProjectId('git', normalized),
        displayName: displayNameFromRemote(normalized),
        root: canonicalRoot,
        remote: normalized,
      };
    }
    return {
      id: hashedProjectId('path', canonicalRoot),
      displayName: basename(canonicalRoot),
      root: canonicalRoot,
    };
  }

  return {
    id: hashedProjectId('path', canonicalCwd),
    displayName: basename(canonicalCwd) || canonicalCwd,
    root: canonicalCwd,
  };
}

async function findGitLocation(
  startDir: string,
  allowExternalGit: boolean,
): Promise<GitLocation | null> {
  let dir = startDir;
  for (;;) {
    const dotGit = join(dir, '.git');
    // `lstat`, not `stat`: a symlinked `.git` is not followed, so repository
    // discovery cannot escape the tree by link.
    const entry = await lstat(dotGit).catch(() => null);
    if (entry?.isDirectory()) {
      return { root: dir, configDir: dotGit };
    }
    if (entry?.isFile() && allowExternalGit) {
      const gitDir = await readGitDirFile(dotGit);
      if (gitDir) {
        return { root: dir, configDir: await resolveCommonDir(gitDir) };
      }
    }
    // Before consent, only the project root itself is examined: a `.git` file's
    // `gitdir:` and an ancestor `.git` are out-of-project reads (roadmap S5).
    if (!allowExternalGit) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function readGitDirFile(dotGitFile: string): Promise<string | null> {
  const read = await readTextFileGuarded(dotGitFile, MAX_PARSE_BYTES, dirname(dotGitFile));
  if (read.status !== 'ok') return null;
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(read.text);
  const target = match?.[1];
  return target ? resolve(dirname(dotGitFile), target) : null;
}

async function resolveCommonDir(gitDir: string): Promise<string> {
  const read = await readTextFileGuarded(join(gitDir, 'commondir'), MAX_PARSE_BYTES, gitDir);
  const target = read.status === 'ok' ? read.text.trim() : '';
  return target ? resolve(gitDir, target) : gitDir;
}

async function readRemoteUrl(location: GitLocation): Promise<string | null> {
  // Guarded: `config` may be a symlink planted by a hostile clone, which would
  // otherwise leak an out-of-project remote into the id before consent (and
  // break the no-symlink-traversal invariant).
  const read = await readTextFileGuarded(
    join(location.configDir, 'config'),
    MAX_PARSE_BYTES,
    location.configDir,
  );
  return read.status === 'ok' ? parseRemoteUrl(read.text) : null;
}

/** Prefers `origin`; falls back to the first configured remote. */
function parseRemoteUrl(configText: string): string | null {
  let section: string | null = null;
  let originUrl: string | null = null;
  let firstRemoteUrl: string | null = null;

  for (const rawLine of configText.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1).trim();
      continue;
    }
    if (section === null) continue;
    const remoteMatch = /^remote\s+"([^"]*)"$/.exec(section);
    if (!remoteMatch) continue;
    const urlMatch = /^url\s*=\s*(.+)$/.exec(line);
    const url = urlMatch?.[1]?.trim();
    if (!url) continue;
    if (remoteMatch[1] === 'origin' && originUrl === null) originUrl = url;
    if (firstRemoteUrl === null) firstRemoteUrl = url;
  }

  return originUrl ?? firstRemoteUrl;
}

/**
 * Reduces the equivalent spellings of one remote to a single canonical string:
 * `ssh://git@github.com/o/r.git`, `git@github.com:o/r.git`, and
 * `https://github.com/o/r` all become `github.com/o/r`.
 */
export function normalizeRemoteUrl(remote: string): string {
  const trimmed = remote.trim().replace(/[?#].*$/, '');
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');

  let hostPath: string;
  if (withoutScheme !== trimmed) {
    hostPath = withoutScheme.replace(/^[^@/]*@/, '');
  } else if (/^[^/@]+@[^/:]+:/.test(trimmed)) {
    hostPath = trimmed.replace(/^[^@/]*@/, '').replace(':', '/');
  } else {
    hostPath = trimmed;
  }

  const segments = hostPath.split('/');
  const host = segments[0];
  if (host && segments.length > 1) {
    segments[0] = host.replace(/:\d+$/, '');
  }

  return segments
    .filter((segment, index) => index === 0 || segment !== '')
    .join('/')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

function displayNameFromRemote(normalized: string): string {
  const segments = normalized.split('/').filter(Boolean);
  const [owner, repo] = segments.slice(-2);
  if (owner && repo) return `${owner}/${repo}`;
  return repo ?? owner ?? normalized;
}

/** A filesystem-safe id: it becomes a directory name under `~/.pfl/projects/`. */
function hashedProjectId(prefix: 'git' | 'path', key: string): string {
  const digest = sha256Digest(key);
  return `${prefix}-${digest.slice('sha256:'.length, 'sha256:'.length + 16)}`;
}
