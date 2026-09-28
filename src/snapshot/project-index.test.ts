import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_CODES, PflError } from '../cli/exit-codes.js';
import { pathDerivedProjectId } from '../discovery/project-identity.js';
import type { ProjectContext } from '../runtime/types.js';
import {
  PROJECT_INDEX_VERSION,
  clearDeadPath,
  isDeadPath,
  markDeadPath,
  projectIndexPath,
  readProjectIndex,
  resolveStoredProjectId,
} from './project-index.js';
import { isSafeSegment, projectDir } from './store.js';

const tempDirs: string[] = [];

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pfl-index-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const REMOTE = 'github.com/owner/repo';
const LEGACY = 'git-0000000000000000';

function gitContext(root: string, legacyId = LEGACY): ProjectContext {
  return { id: legacyId, displayName: 'owner/repo', root, remote: REMOTE };
}

async function seedHistory(home: string, id: string, mtimeMs: number): Promise<void> {
  await mkdir(projectDir(id, home), { recursive: true });
  await writeFile(
    join(projectDir(id, home), 'latest'),
    '{"observed":"obs_x","resolved":"res_x"}\n',
  );
  const time = new Date(mtimeMs);
  await utimes(join(projectDir(id, home), 'latest'), time, time);
}

describe('project index', () => {
  it('is empty until a root is resolved', async () => {
    const home = await tempHome();
    await expect(readProjectIndex(home)).resolves.toEqual({
      indexVersion: PROJECT_INDEX_VERSION,
      projects: {},
    });
  });

  it('assigns the legacy id to an unseen root and keeps it for the project’s lifetime', async () => {
    const home = await tempHome();
    const first = await resolveStoredProjectId(gitContext('/repo'), home);
    expect(first.id).toBe(LEGACY);

    // A remote change must not mint a new id: the index wins over derivation.
    const afterRemoteChange = await resolveStoredProjectId(
      gitContext('/repo', 'git-ffffffffffffffff'),
      home,
    );
    expect(afterRemoteChange.id).toBe(LEGACY);

    // Removing the remote changes nothing either.
    const withoutRemote = await resolveStoredProjectId(
      { id: pathDerivedProjectId('/repo'), displayName: 'repo', root: '/repo' },
      home,
    );
    expect(withoutRemote.id).toBe(LEGACY);

    const index = await readProjectIndex(home);
    expect(index.projects['/repo']).toBe(LEGACY);
  });

  it('adopts an existing legacy history rather than abandoning it', async () => {
    const home = await tempHome();
    await seedHistory(home, LEGACY, 1_000);
    const before = await readFile(join(projectDir(LEGACY, home), 'latest'), 'utf8');

    const resolved = await resolveStoredProjectId(gitContext('/repo'), home);

    expect(resolved.id).toBe(LEGACY);
    expect(resolved.diagnostics.map((entry) => entry.code)).toContain('adopted-legacy-history');
    // Nothing in the adopted directory is moved or rewritten.
    expect(await readFile(join(projectDir(LEGACY, home), 'latest'), 'utf8')).toBe(before);
  });

  it('adopts the more recent of a remote-derived and a path-derived history', async () => {
    const home = await tempHome();
    const pathId = pathDerivedProjectId('/repo');
    await seedHistory(home, LEGACY, 1_000);
    await seedHistory(home, pathId, 2_000);

    const resolved = await resolveStoredProjectId(gitContext('/repo'), home);

    expect(resolved.id).toBe(pathId);
  });

  it('gives a second clone of one remote its own history and says where the shared one is', async () => {
    const home = await tempHome();
    const first = await resolveStoredProjectId(gitContext('/clone-a'), home);
    expect(first.id).toBe(LEGACY);

    const second = await resolveStoredProjectId(gitContext('/clone-b'), home);

    expect(second.id).not.toBe(LEGACY);
    const shared = second.diagnostics.find((entry) => entry.code === 'shared-legacy-history');
    expect(shared?.message).toContain(projectDir(LEGACY, home));
    const index = await readProjectIndex(home);
    expect(index.projects['/clone-a']).toBe(LEGACY);
    expect(index.projects['/clone-b']).toBe(second.id);
  });

  it('refuses a corrupt index rather than guessing, naming the file', async () => {
    const home = await tempHome();
    await mkdir(join(home, '.pfl'), { recursive: true });
    await writeFile(projectIndexPath(home), '{ not json');

    const error = await resolveStoredProjectId(gitContext('/repo'), home).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PflError);
    expect((error as PflError).exitCode).toBe(EXIT_CODES.SNAPSHOT_STORE_FAILED);
    expect((error as PflError).message).toContain('~/.pfl/index.json');
  });

  it('refuses an unsupported index version or an unsafe id', async () => {
    const home = await tempHome();
    await mkdir(join(home, '.pfl'), { recursive: true });

    // v2 is now supported; use v3 as unsupported.
    await writeFile(projectIndexPath(home), '{"indexVersion":"3","projects":{}}\n');
    await expect(resolveStoredProjectId(gitContext('/repo'), home)).rejects.toMatchObject({
      exitCode: EXIT_CODES.SNAPSHOT_STORE_FAILED,
    });

    await writeFile(
      projectIndexPath(home),
      '{"indexVersion":"1","projects":{"/repo":"../../etc"}}\n',
    );
    await expect(resolveStoredProjectId(gitContext('/repo'), home)).rejects.toMatchObject({
      exitCode: EXIT_CODES.SNAPSHOT_STORE_FAILED,
    });

    await writeFile(
      projectIndexPath(home),
      '{"indexVersion":"1","projects":{"relative/path":"path-0123456789abcdef"}}\n',
    );
    await expect(resolveStoredProjectId(gitContext('/repo'), home)).rejects.toMatchObject({
      exitCode: EXIT_CODES.SNAPSHOT_STORE_FAILED,
    });
  });

  it('checks a safe segment without regex state leaking between calls', () => {
    expect(isSafeSegment('path-0123456789abcdef')).toBe(true);
    expect(isSafeSegment('path-0123456789abcdef')).toBe(true);
    expect(isSafeSegment('../etc')).toBe(false);
  });

  it('does not write the index for a read-only resolution', async () => {
    const home = await tempHome();
    const resolved = await resolveStoredProjectId(gitContext('/repo'), home, { write: false });
    expect(resolved.id).toBe(LEGACY);
    await expect(access(projectIndexPath(home))).rejects.toThrow();
  });

  it('reads v1 index (flat strings) and writes v2 on upgrade', async () => {
    const home = await tempHome();
    await mkdir(join(home, '.pfl'), { recursive: true });
    await writeFile(
      projectIndexPath(home),
      '{"indexVersion":"1","projects":{"/existing":"git-0000000000000000"}}\n',
    );

    // Read: v1 is accepted.
    const index = await readProjectIndex(home);
    expect(index.projects['/existing']).toBe('git-0000000000000000');

    // A new root triggers a write, which upgrades to v2.
    await resolveStoredProjectId(gitContext('/new-repo'), home);
    const written = JSON.parse(await readFile(projectIndexPath(home), 'utf8'));
    expect(written.indexVersion).toBe(PROJECT_INDEX_VERSION);
  });

  it('marks and clears dead-path idempotently', async () => {
    const home = await tempHome();
    await resolveStoredProjectId(gitContext('/repo'), home);

    // Mark dead-path.
    const mark1 = await markDeadPath('/repo', home);
    expect(mark1.diagnostics).toEqual([]);
    expect(await isDeadPath('/repo', home)).toBe(true);

    // Mark again: idempotent.
    const mark2 = await markDeadPath('/repo', home);
    expect(mark2.diagnostics).toEqual([]);

    // Clear dead-path.
    const clear1 = await clearDeadPath('/repo', home);
    expect(clear1.diagnostics).toEqual([]);
    expect(await isDeadPath('/repo', home)).toBe(false);

    // Clear again: idempotent.
    const clear2 = await clearDeadPath('/repo', home);
    expect(clear2.diagnostics).toEqual([]);
  });

  it('returns diagnostic for dead-path on unknown root', async () => {
    const home = await tempHome();
    const result = await markDeadPath('/unknown', home);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe('unknown-project-root');
  });

  it('isDeadPath returns false for unknown root', async () => {
    const home = await tempHome();
    expect(await isDeadPath('/unknown', home)).toBe(false);
  });
});
