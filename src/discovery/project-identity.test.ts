import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeRemoteUrl, resolveProjectContext } from './project-identity.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pfl-identity-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function gitConfig(url: string, remote = 'origin'): string {
  return [
    '[core]',
    '\trepositoryformatversion = 0',
    `[remote "${remote}"]`,
    `\turl = ${url}`,
    '',
  ].join('\n');
}

async function makeGitRepo(root: string, url?: string): Promise<string> {
  const gitDir = join(root, '.git');
  await mkdir(gitDir, { recursive: true });
  if (url !== undefined) {
    await writeFile(join(gitDir, 'config'), gitConfig(url));
  }
  return root;
}

describe('resolveProjectContext', () => {
  it('derives a Git identity from the canonical remote', async () => {
    const dir = await tempDir();
    await makeGitRepo(dir, 'git@github.com:owner/repo.git');

    const project = await resolveProjectContext(dir);

    expect(project.displayName).toBe('owner/repo');
    expect(project.remote).toBe('github.com/owner/repo');
    expect(project.id).toMatch(/^git-[0-9a-f]{16}$/);
  });

  it('gives the same id to equivalent remote spellings', async () => {
    const spellings = [
      'git@github.com:owner/repo.git',
      'ssh://git@github.com/owner/repo.git',
      'https://github.com/owner/repo',
    ];
    const ids = await Promise.all(
      spellings.map(async (url) => {
        const dir = await tempDir();
        return (await resolveProjectContext(await makeGitRepo(dir, url))).id;
      }),
    );
    expect(new Set(ids).size).toBe(1);
  });

  it('gives the same id to the same repository cloned to two paths', async () => {
    const a = await resolveProjectContext(
      await makeGitRepo(await tempDir(), 'git@github.com:o/r.git'),
    );
    const b = await resolveProjectContext(
      await makeGitRepo(await tempDir(), 'git@github.com:o/r.git'),
    );
    expect(a.id).toBe(b.id);
    expect(a.root).not.toBe(b.root);
  });

  it('resolves a nested subdirectory to the repository root when external Git is allowed', async () => {
    const dir = await tempDir();
    await makeGitRepo(dir, 'git@github.com:o/r.git');
    const nested = join(dir, 'src', 'deep');
    await mkdir(nested, { recursive: true });

    const project = await resolveProjectContext(nested, { allowExternalGit: true });

    expect(project.displayName).toBe('o/r');
    expect(project.id).toMatch(/^git-/);
  });

  it('does not search above the root before consent', async () => {
    const dir = await tempDir();
    await makeGitRepo(dir, 'git@github.com:o/r.git');
    const nested = join(dir, 'src', 'deep');
    await mkdir(nested, { recursive: true });

    const project = await resolveProjectContext(nested);

    expect(project.id).toMatch(/^path-/);
    expect(project.remote).toBeUndefined();
  });

  it('resolves a linked worktree through gitdir and commondir when external Git is allowed', async () => {
    const main = await tempDir();
    await makeGitRepo(main, 'git@github.com:o/r.git');

    const worktree = await tempDir();
    const gitDir = join(main, '.git', 'worktrees', 'wt');
    await mkdir(gitDir, { recursive: true });
    await writeFile(join(gitDir, 'commondir'), '../..\n');
    await writeFile(join(worktree, '.git'), `gitdir: ${gitDir}\n`);

    const [mainProject, worktreeProject] = await Promise.all([
      resolveProjectContext(main, { allowExternalGit: true }),
      resolveProjectContext(worktree, { allowExternalGit: true }),
    ]);

    expect(worktreeProject.remote).toBe('github.com/o/r');
    expect(worktreeProject.id).toBe(mainProject.id);
  });

  it('does not follow a .git file before consent', async () => {
    const dir = await tempDir();
    const outside = await tempDir();
    const outsideGit = join(outside, 'gitdir');
    await mkdir(outsideGit, { recursive: true });
    await writeFile(join(outsideGit, 'config'), gitConfig('git@github.com:secret/leak.git'));
    await writeFile(join(dir, '.git'), `gitdir: ${outsideGit}\n`);

    const project = await resolveProjectContext(dir);

    // The gitdir target is out of project: not read, so no remote and a path id.
    expect(project.remote).toBeUndefined();
    expect(project.id).toMatch(/^path-/);
  });

  it('still reads a .git directory inside the root before consent', async () => {
    const dir = await tempDir();
    await makeGitRepo(dir, 'git@github.com:owner/repo.git');

    const project = await resolveProjectContext(dir);

    expect(project.remote).toBe('github.com/owner/repo');
    expect(project.id).toMatch(/^git-/);
  });

  it('does not follow a symlinked .git/config', async () => {
    const dir = await tempDir();
    const outside = await tempDir();
    await writeFile(join(outside, 'config'), gitConfig('git@github.com:secret/leak.git'));
    await mkdir(join(dir, '.git'), { recursive: true });
    await symlink(join(outside, 'config'), join(dir, '.git', 'config'));

    const project = await resolveProjectContext(dir);

    expect(project.remote).toBeUndefined();
    expect(project.id).toMatch(/^path-/);
  });

  it('prefers origin over another remote', async () => {
    const dir = await tempDir();
    const gitDir = join(dir, '.git');
    await mkdir(gitDir, { recursive: true });
    await writeFile(
      join(gitDir, 'config'),
      `${gitConfig('git@github.com:upstream/fork.git', 'upstream')}\n${gitConfig('git@github.com:owner/repo.git')}`,
    );

    const project = await resolveProjectContext(dir);

    expect(project.remote).toBe('github.com/owner/repo');
  });

  it('falls back to the path for a Git repository without a remote', async () => {
    const dir = await tempDir();
    await makeGitRepo(dir);

    const project = await resolveProjectContext(dir);

    expect(project.id).toMatch(/^path-[0-9a-f]{16}$/);
    expect(project.remote).toBeUndefined();
  });

  it('uses the canonical path for a non-Git directory', async () => {
    const dir = await tempDir();

    const project = await resolveProjectContext(dir);

    expect(project.id).toMatch(/^path-[0-9a-f]{16}$/);
    expect(project.displayName).toBe(basename(dir));
    expect(project.remote).toBeUndefined();
  });
});

describe('normalizeRemoteUrl', () => {
  it.each([
    ['ssh://git@github.com/o/r.git', 'github.com/o/r'],
    ['git@github.com:o/r.git', 'github.com/o/r'],
    ['https://github.com/o/r', 'github.com/o/r'],
    ['https://github.com/o/r/', 'github.com/o/r'],
    ['https://user:pass@github.com/o/r.git', 'github.com/o/r'],
    ['ssh://git@github.com:22/o/r.git', 'github.com/o/r'],
    ['/Users/x/repo.git', '/Users/x/repo'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeRemoteUrl(input)).toBe(expected);
  });
});
