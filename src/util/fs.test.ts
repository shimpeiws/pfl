import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSymlinkAncestors, inspectFileTarget, isPathWithin } from './fs.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pfl-fs-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('isPathWithin', () => {
  it('accepts the parent itself and a nested child', async () => {
    const base = await tempDir();
    const parent = join(base, 'a', 'b');
    await mkdir(parent, { recursive: true });

    expect(await isPathWithin(parent, parent)).toBe(true);
    expect(await isPathWithin(parent, join(parent, 'c', 'd'))).toBe(true);
  });

  it('rejects a sibling whose name shares the parent prefix', async () => {
    const base = await tempDir();
    const parent = join(base, 'a', 'b');
    await mkdir(parent, { recursive: true });
    await mkdir(join(base, 'a', 'bc'), { recursive: true });

    expect(await isPathWithin(parent, join(base, 'a', 'bc'))).toBe(false);
    expect(await isPathWithin(parent, join(base, 'a', 'bc', 'file'))).toBe(false);
  });

  it('rejects a path outside the parent', async () => {
    const base = await tempDir();
    const parent = join(base, 'a');
    await mkdir(parent, { recursive: true });

    expect(await isPathWithin(parent, join(base, 'other'))).toBe(false);
    expect(await isPathWithin(parent, base)).toBe(false);
  });

  it('resolves a symlinked ancestor before comparing', async () => {
    const base = await tempDir();
    const real = join(base, 'real');
    const link = join(base, 'link');
    await mkdir(real, { recursive: true });
    await symlink(real, link);

    expect(await isPathWithin(real, join(link, 'file'))).toBe(true);
  });
});

describe('checkSymlinkAncestors / inspectFileTarget', () => {
  it('refuses a target reached through a symlinked ancestor component', async () => {
    const base = await tempDir();
    const outside = join(base, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'settings.json'), '{}');
    await symlink(outside, join(base, 'link'));

    expect(await checkSymlinkAncestors(base, join(base, 'link', 'settings.json'))).toBe('symlink');
    expect((await inspectFileTarget(join(base, 'link', 'settings.json'), base)).status).not.toBe(
      'ok',
    );
  });

  it('fails closed when the target is not under the base directory', async () => {
    const base = await tempDir();
    const outside = join(base, 'outside');
    await mkdir(outside, { recursive: true });

    expect(await checkSymlinkAncestors(outside, join(base, 'anything'))).toBe('outside-base');
    expect((await inspectFileTarget(join(base, 'anything'), outside)).status).not.toBe('ok');
  });

  it('accepts a regular file under the base directory', async () => {
    const base = await tempDir();
    await writeFile(join(base, 'file'), 'x');

    expect(await checkSymlinkAncestors(base, join(base, 'file'))).toBe('ok');
    expect((await inspectFileTarget(join(base, 'file'), base)).status).toBe('ok');
  });
});
