import { execFileSync } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES, MAX_WALK_DEPTH, MAX_WALK_ENTRIES } from '../limits.js';
import { sha256Digest } from '../util/hash.js';
import { walkHarnessPaths } from './walk.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pfl-walk-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Whether this environment actually denies reads to a mode-000 file. Running as
 * root (or on a filesystem that ignores the mode) makes the read succeed, so the
 * unreadable-file case is skipped visibly rather than passing without asserting.
 */
const canTestUnreadable = await (async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pfl-walk-perm-'));
  const probe = join(dir, 'probe');
  try {
    await writeFile(probe, 'probe');
    await chmod(probe, 0o000);
    return await readFile(probe).then(
      () => false,
      () => true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})();

interface Fixture {
  root: string;
  settings: string;
  skill: string;
  unknown: string;
  secret: string;
  link: string;
}

async function makeFixture(): Promise<Fixture> {
  const base = await tempDir();
  const root = join(base, 'project');
  const outside = join(base, 'outside');

  await mkdir(join(root, '.claude', 'skills', 'foo'), { recursive: true });
  await mkdir(outside, { recursive: true });

  const settings = join(root, '.claude', 'settings.json');
  const skill = join(root, '.claude', 'skills', 'foo', 'SKILL.md');
  const unknown = join(root, '.claude', 'unknown.xyz');
  const secret = join(root, '.claude', 'secret.txt');
  const link = join(root, '.claude', 'link');

  await writeFile(settings, '{"model":"opus"}');
  await writeFile(skill, '# Foo skill');
  await writeFile(unknown, 'not a known harness file');
  await writeFile(secret, 'hunter2');
  await writeFile(join(outside, 'leaked.txt'), 'outside the project');
  await symlink(join('..', '..', 'outside'), link);

  return { root, settings, skill, unknown, secret, link };
}

describe('walkHarnessPaths', () => {
  it('walks files, nested directories, and unknown files', async () => {
    const fixture = await makeFixture();

    const { entries } = await walkHarnessPaths(fixture.root, ['.claude']);

    const byPath = new Map(entries.map((entry) => [entry.relativePath, entry]));
    expect(byPath.get('.claude/settings.json')?.kind).toBe('file');
    expect(byPath.get('.claude/settings.json')?.digest).toBe(sha256Digest('{"model":"opus"}'));
    expect(byPath.get('.claude/settings.json')?.sizeBytes).toBe('{"model":"opus"}'.length);
    expect(byPath.get('.claude/skills')?.kind).toBe('directory');
    expect(byPath.get('.claude/skills/foo/SKILL.md')?.kind).toBe('file');
    expect(byPath.get('.claude/unknown.xyz')?.kind).toBe('file');
  });

  it('records a symlink once and never follows it', async () => {
    const fixture = await makeFixture();

    const { entries } = await walkHarnessPaths(fixture.root, ['.claude']);

    const symlinks = entries.filter((entry) => entry.kind === 'symlink');
    expect(symlinks).toHaveLength(1);
    expect(symlinks[0]?.relativePath).toBe('.claude/link');
    expect(entries.some((entry) => entry.relativePath.includes('outside'))).toBe(false);
    expect(entries.some((entry) => entry.relativePath.includes('leaked'))).toBe(false);
  });

  it.skipIf(!canTestUnreadable)(
    'records an unreadable file as a diagnostic and continues',
    async () => {
      const fixture = await makeFixture();
      await chmod(fixture.secret, 0o000);

      const { entries, diagnostics } = await walkHarnessPaths(fixture.root, ['.claude']);

      expect(diagnostics.some((d) => d.code === 'unreadable-file')).toBe(true);
      expect(entries.find((e) => e.relativePath === '.claude/secret.txt')?.digest).toBeUndefined();
      // The walk never aborts: a readable sibling is still discovered.
      expect(entries.some((e) => e.relativePath === '.claude/settings.json')).toBe(true);
    },
  );

  it('does not follow a symlinked ancestor in a subpath', async () => {
    const fixture = await makeFixture();

    const { entries, diagnostics } = await walkHarnessPaths(fixture.root, [
      '.claude/link/leaked.txt',
    ]);

    expect(entries).toHaveLength(0);
    expect(diagnostics.some((d) => d.code === 'path-outside-root')).toBe(true);
  });

  it('reports a subpath that escapes the root instead of walking it', async () => {
    const fixture = await makeFixture();

    const { entries, diagnostics } = await walkHarnessPaths(fixture.root, ['../outside']);

    expect(entries).toHaveLength(0);
    expect(diagnostics.some((d) => d.code === 'path-outside-root')).toBe(true);
  });

  it('reports a missing subpath as a diagnostic', async () => {
    const fixture = await makeFixture();

    const { entries, diagnostics } = await walkHarnessPaths(fixture.root, ['.claude/nope']);

    expect(entries).toHaveLength(0);
    expect(diagnostics.some((d) => d.code === 'path-not-found')).toBe(true);
  });

  it('returns entries in a deterministic order', async () => {
    const fixture = await makeFixture();

    const first = await walkHarnessPaths(fixture.root, ['.claude']);
    const second = await walkHarnessPaths(fixture.root, ['.claude']);

    expect(first.entries.map((e) => e.relativePath)).toEqual(
      second.entries.map((e) => e.relativePath),
    );
    expect(first.entries.map((e) => e.relativePath)).toEqual(
      [...first.entries.map((e) => e.relativePath)].sort(),
    );
  });
});

describe('walkHarnessPaths hostile input (S3, S7)', () => {
  it('refuses a hardlinked regular file (nlink > 1)', async () => {
    const fixture = await makeFixture();
    const original = join(dirname(fixture.root), 'shared-inode.txt');
    await writeFile(original, 'shared inode');
    await link(original, join(fixture.root, '.claude', 'hardlinked.txt'));

    const { entries, diagnostics } = await walkHarnessPaths(fixture.root, ['.claude']);

    const hard = entries.find((entry) => entry.relativePath === '.claude/hardlinked.txt');
    expect(hard?.skipReason).toBe('hardlink-not-followed');
    expect(hard?.digest).toBeUndefined();
    expect(diagnostics.some((diagnostic) => diagnostic.code === 'hardlink-not-followed')).toBe(
      true,
    );
  });

  it('refuses a file over MAX_FILE_BYTES before reading it', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.root, '.claude', 'huge.bin'), Buffer.alloc(MAX_FILE_BYTES + 1));

    const { entries, diagnostics } = await walkHarnessPaths(fixture.root, ['.claude']);

    const huge = entries.find((entry) => entry.relativePath === '.claude/huge.bin');
    expect(huge?.skipReason).toBe('file-too-large');
    expect(huge?.digest).toBeUndefined();
    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'limit-exceeded' && diagnostic.message.includes('MAX_FILE_BYTES'),
      ),
    ).toBe(true);
  });

  it('stops at MAX_WALK_ENTRIES and reports the ceiling it hit', async () => {
    const fixture = await makeFixture();
    const many = join(fixture.root, '.claude', 'many');
    await mkdir(many, { recursive: true });
    await Promise.all(
      Array.from({ length: MAX_WALK_ENTRIES + 10 }, (_, index) =>
        writeFile(join(many, `f${index}`), ''),
      ),
    );

    const { entries, diagnostics } = await walkHarnessPaths(fixture.root, ['.claude']);

    expect(entries.length).toBeLessThanOrEqual(MAX_WALK_ENTRIES);
    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'limit-exceeded' &&
          diagnostic.message.includes('MAX_WALK_ENTRIES') &&
          diagnostic.message.includes(String(MAX_WALK_ENTRIES)),
      ),
    ).toBe(true);
  });

  it('stops descending at MAX_WALK_DEPTH', async () => {
    const fixture = await makeFixture();
    let deep = join(fixture.root, '.claude', 'deep');
    for (let level = 0; level <= MAX_WALK_DEPTH + 2; level += 1) {
      deep = join(deep, `d${level}`);
    }
    await mkdir(deep, { recursive: true });

    const { diagnostics } = await walkHarnessPaths(fixture.root, ['.claude']);

    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'limit-exceeded' && diagnostic.message.includes('MAX_WALK_DEPTH'),
      ),
    ).toBe(true);
  });

  it('never opens a FIFO and records it as a non-regular entry', async () => {
    const fixture = await makeFixture();
    execFileSync('mkfifo', [join(fixture.root, '.claude', 'pipe')]);

    const { entries, diagnostics } = await walkHarnessPaths(fixture.root, ['.claude']);

    const fifo = entries.find((entry) => entry.relativePath === '.claude/pipe');
    expect(fifo?.kind).toBe('unknown');
    expect(fifo?.digest).toBeUndefined();
    expect(diagnostics.some((diagnostic) => diagnostic.code === 'non-regular-file')).toBe(true);
  });
});
