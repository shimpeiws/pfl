import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectCodex } from './detect.js';

const tempDirs: string[] = [];

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pfl-codex-detect-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRelease(home: string, release: string): Promise<void> {
  await mkdir(join(home, '.codex', 'packages', 'standalone', 'releases', release), {
    recursive: true,
  });
}

describe('detectCodex', () => {
  it('reports a present, verified installation', async () => {
    const home = await tempHome();
    await makeRelease(home, '0.154.0-aarch64-apple-darwin');

    const detection = await detectCodex(home);

    expect(detection.installed).toBe(true);
    expect(detection.version).toBe('0.154.0');
    expect(detection.runtimeCompatibility).toBe('verified');
    expect(detection.diagnostics).toEqual([]);
  });

  it('takes the highest release', async () => {
    const home = await tempHome();
    await makeRelease(home, '0.150.0-aarch64-apple-darwin');
    await makeRelease(home, '0.154.0-aarch64-apple-darwin');
    await makeRelease(home, '0.139.0-aarch64-apple-darwin');

    const detection = await detectCodex(home);

    expect(detection.version).toBe('0.154.0');
  });

  it('reports a present-but-newer installation as unverified without failing', async () => {
    const home = await tempHome();
    await makeRelease(home, '0.160.0-aarch64-apple-darwin');

    const detection = await detectCodex(home);

    expect(detection.installed).toBe(true);
    expect(detection.version).toBe('0.160.0');
    expect(detection.runtimeCompatibility).toBe('unverified');
    expect(detection.diagnostics.map((d) => d.code)).toContain('runtime-version-unverified');
  });

  it('reports present-but-version-unreadable with a null version', async () => {
    const home = await tempHome();
    await makeRelease(home, 'not-a-version');

    const detection = await detectCodex(home);

    expect(detection.installed).toBe(true);
    expect(detection.version).toBeNull();
    expect(detection.runtimeCompatibility).toBe('unverified');
    expect(detection.diagnostics.map((d) => d.code)).toContain('runtime-version-unknown');
  });

  it('reports an absent installation', async () => {
    const home = await tempHome();

    const detection = await detectCodex(home);

    expect(detection.installed).toBe(false);
    expect(detection.version).toBeNull();
    expect(detection.diagnostics.map((d) => d.code)).toContain('runtime-not-found');
  });

  it('does not treat a bare config directory as installed', async () => {
    const home = await tempHome();
    await mkdir(join(home, '.codex'), { recursive: true });

    const detection = await detectCodex(home);

    expect(detection.installed).toBe(false);
  });
});
