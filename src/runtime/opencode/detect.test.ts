import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectOpencode, VERIFIED_OPENCODE_VERSIONS } from './detect.js';

const tempDirs: string[] = [];

async function tempHome(): Promise<string> {
  // Canonicalised so the ancestor guard, which walks from the filesystem root,
  // is not tripped by macOS's `/var` symlink.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pfl-opencode-detect-')));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A Homebrew-shaped prefix holding `bin/opencode` and a `Cellar/opencode/<version>`. */
async function makeBrewInstall(home: string, version: string): Promise<string> {
  const prefix = join(home, 'brew');
  await mkdir(join(prefix, 'bin'), { recursive: true });
  await writeFile(join(prefix, 'bin', 'opencode'), '');
  await mkdir(join(prefix, 'Cellar', 'opencode', version), { recursive: true });
  return join(prefix, 'bin');
}

describe('detectOpencode', () => {
  it.each(VERIFIED_OPENCODE_VERSIONS)(
    'reports a present, verified installation (%s)',
    async (version) => {
      const home = await tempHome();
      const bin = await makeBrewInstall(home, version);

      const detection = await detectOpencode(home, bin);

      expect(detection.installed).toBe('yes');
      expect(detection.version).toBe(version);
      expect(detection.runtimeCompatibility).toBe('verified');
      expect(detection.diagnostics).toEqual([]);
    },
  );

  it('does not verify a version inside the numeric span that was never measured', async () => {
    const home = await tempHome();
    const bin = await makeBrewInstall(home, '1.18.15');

    const detection = await detectOpencode(home, bin);

    expect(detection.version).toBe('1.18.15');
    expect(detection.runtimeCompatibility).toBe('unverified');
    const codes = detection.diagnostics.map((d) => d.code);
    expect(codes).toContain('runtime-version-unverified');
    // Not below: it is between measured versions, not older than all of them.
    expect(codes).not.toContain('runtime-version-below-verified');
  });

  it('reports a below-verified installation with the distinct diagnostic', async () => {
    const home = await tempHome();
    const bin = await makeBrewInstall(home, '1.17.0');

    const detection = await detectOpencode(home, bin);

    expect(detection.version).toBe('1.17.0');
    expect(detection.runtimeCompatibility).toBe('unverified');
    expect(detection.diagnostics.map((d) => d.code)).toContain('runtime-version-below-verified');
  });

  it('reports an above-verified installation without blocking', async () => {
    const home = await tempHome();
    const bin = await makeBrewInstall(home, '1.19.0');

    const detection = await detectOpencode(home, bin);

    expect(detection.installed).toBe('yes');
    expect(detection.version).toBe('1.19.0');
    expect(detection.runtimeCompatibility).toBe('unverified');
    expect(detection.diagnostics.map((d) => d.code)).toContain('runtime-version-unverified');
  });

  it('reports an absent installation', async () => {
    const home = await tempHome();

    const detection = await detectOpencode(home, '');

    expect(detection.installed).toBe('no');
    expect(detection.version).toBeNull();
    expect(detection.diagnostics.map((d) => d.code)).toContain('runtime-not-found');
  });

  it('does not treat a bare config directory as installed', async () => {
    const home = await tempHome();
    await mkdir(join(home, '.config', 'opencode'), { recursive: true });

    const detection = await detectOpencode(home, '');

    expect(detection.installed).toBe('no');
  });

  it('detects a PATH-only install with an unknown version', async () => {
    const home = await tempHome();
    const bin = join(home, 'custom-bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'opencode'), '');

    const detection = await detectOpencode(home, bin);

    expect(detection.installed).toBe('yes');
    expect(detection.version).toBeNull();
    expect(detection.diagnostics.map((d) => d.code)).toContain('runtime-version-unknown');
  });

  it('does not traverse a symlinked PATH entry', async () => {
    const home = await tempHome();
    const target = join(home, 'real-bin');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'opencode'), '');
    await symlink(target, join(home, 'link-bin'));

    const detection = await detectOpencode(home, join(home, 'link-bin'));

    expect(detection.installed).toBe('no');
  });

  it('does not traverse a symlinked PATH ancestor', async () => {
    const home = await tempHome();
    const real = join(home, 'real-parent');
    await mkdir(join(real, 'bin'), { recursive: true });
    await writeFile(join(real, 'bin', 'opencode'), '');
    await symlink(real, join(home, 'link-parent'));

    const detection = await detectOpencode(home, join(home, 'link-parent', 'bin'));

    expect(detection.installed).toBe('no');
  });
});
