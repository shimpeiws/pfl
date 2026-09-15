import { lstat, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { ProjectContext } from '../runtime/types.js';
import { realpathAsFarAsExists } from '../util/fs.js';
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
 */

/** Where `.git` and the remote configuration live for a discovered repository. */
interface GitLocation {
  /** Directory containing the `.git` entry — the canonical repository root. */
  root: string;
  /** Directory holding `config` (the common dir for a linked worktree). */
  configDir: string;
}

export async function resolveProjectContext(cwd: string): Promise<ProjectContext> {
  const canonicalCwd = await realpathAsFarAsExists(resolve(cwd));

  const git = await findGitLocation(canonicalCwd);
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

async function findGitLocation(startDir: string): Promise<GitLocation | null> {
  let dir = startDir;
  for (;;) {
    const dotGit = join(dir, '.git');
    // `lstat`, not `stat`: a symlinked `.git` is not followed, so repository
    // discovery cannot escape the tree by link.
    const entry = await lstat(dotGit).catch(() => null);
    if (entry?.isDirectory()) {
      return { root: dir, configDir: dotGit };
    }
    if (entry?.isFile()) {
      const gitDir = await readGitDirFile(dotGit);
      if (gitDir) {
        return { root: dir, configDir: await resolveCommonDir(gitDir) };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function readGitDirFile(dotGitFile: string): Promise<string | null> {
  const content = await readFile(dotGitFile, 'utf8').catch(() => null);
  if (content === null) return null;
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  const target = match?.[1];
  return target ? resolve(dirname(dotGitFile), target) : null;
}

async function resolveCommonDir(gitDir: string): Promise<string> {
  const content = await readFile(join(gitDir, 'commondir'), 'utf8').catch(() => null);
  const target = content?.trim();
  return target ? resolve(gitDir, target) : gitDir;
}

async function readRemoteUrl(location: GitLocation): Promise<string | null> {
  const content = await readFile(join(location.configDir, 'config'), 'utf8').catch(() => null);
  return content === null ? null : parseRemoteUrl(content);
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
