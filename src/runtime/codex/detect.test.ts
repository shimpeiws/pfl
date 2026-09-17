import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectCodex } from './detect.js';

const tempDirs: string[] = [];

async function tempHome(): Promise<string> {
  // Canonicalised so the ancestor guard, which walks from the filesystem root,
  // is not tripped by macOS's `/var` symlink; a canonical temp root makes the
  // symlink tests exercise the intended component.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pfl-codex-detect-')));
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

/** A bin directory holding `codex`, plus an npm layout under the same prefix. */
async function makeNpmInstall(home: string, version: string): Promise<string> {
  const prefix = join(home, 'npm-prefix');
  await mkdir(join(prefix, 'bin'), { recursive: true });
  await mkdir(join(prefix, 'lib', 'node_modules', '@openai', 'codex'), { recursive: true });
  await writeFile(join(prefix, 'bin', 'codex'), '');
  await writeFile(
    join(prefix, 'lib', 'node_modules', '@openai', 'codex', 'package.json'),
    JSON.stringify({ version }),
  );
  return join(prefix, 'bin');
}

describe('detectCodex', () => {
  it('reports a present, verified installation', async () => {
    const home = await tempHome();
    await makeRelease(home, '0.154.0-aarch64-apple-darwin');

    const detection = await detectCodex(home, '');

    expect(detection.installed).toBe('yes');
    expect(detection.version).toBe('0.154.0');
    expect(detection.runtimeCompatibility).toBe('verified');
    expect(detection.diagnostics).toEqual([]);
  });

  it('takes the highest release', async () => {
    const home = await tempHome();
    await makeRelease(home, '0.150.0-aarch64-apple-darwin');
    await makeRelease(home, '0.154.0-aarch64-apple-darwin');
    await makeRelease(home, '0.139.0-aarch64-apple-darwin');

    const detection = await detectCodex(home, '');

    expect(detection.version).toBe('0.154.0');
  });

  it('reports a newer-than-verified installation with the unverified diagnostic, without failing', async () => {
    const home = await tempHome();
    await makeRelease(home, '0.160.0-aarch64-apple-darwin');

    const detection = await detectCodex(home, '');

    expect(detection.installed).toBe('yes');
    expect(detection.version).toBe('0.160.0');
    expect(detection.runtimeCompatibility).toBe('unverified');
    expect(detection.diagnostics.map((d) => d.code)).toContain('runtime-version-unverified');
    expect(detection.diagnostics.map((d) => d.code)).not.toContain(
      'runtime-version-below-verified',
    );
  });

  it('reports an older-than-verified installation with a distinct diagnostic', async () => {
    const home = await tempHome();
    await makeRelease(home, '0.140.0-aarch64-apple-darwin');

    const detection = await detectCodex(home, '');

    expect(detection.installed).toBe('yes');
    expect(detection.version).toBe('0.140.0');
    expect(detection.runtimeCompatibility).toBe('unverified');
    expect(detection.diagnostics.map((d) => d.code)).toContain('runtime-version-below-verified');
    expect(detection.diagnostics.map((d) => d.code)).not.toContain('runtime-version-unverified');
  });

  it('reports present-but-version-unreadable with a null version', async () => {
    const home = await tempHome();
    await makeRelease(home, 'not-a-version');

    const detection = await detectCodex(home, '');

    expect(detection.installed).toBe('yes');
    expect(detection.version).toBeNull();
    expect(detection.runtimeCompatibility).toBe('unverified');
    expect(detection.diagnostics.map((d) => d.code)).toContain('runtime-version-unknown');
  });

  it('reports an absent installation', async () => {
    const home = await tempHome();

    const detection = await detectCodex(home, '');

    expect(detection.installed).toBe('no');
    expect(detection.version).toBeNull();
    expect(detection.diagnostics.map((d) => d.code)).toContain('runtime-not-found');
  });

  it('does not treat a bare config directory as installed', async () => {
    const home = await tempHome();
    await mkdir(join(home, '.codex'), { recursive: true });

    const detection = await detectCodex(home, '');

    expect(detection.installed).toBe('no');
  });

  it('names a stale release directory beside a newer npm package and picks the highest', async () => {
    const home = await tempHome();
    await makeRelease(home, '0.139.0-aarch64-apple-darwin');
    const bin = await makeNpmInstall(home, '0.154.0');

    const detection = await detectCodex(home, bin);
    const disagreement = detection.diagnostics.find(
      (d) => d.code === 'runtime-version-disagreement',
    );

    expect(detection.version).toBe('0.154.0');
    expect(detection.runtimeCompatibility).toBe('verified');
    expect(disagreement).toBeDefined();
    expect(disagreement?.message).toContain('installer releases directory');
    expect(disagreement?.message).toContain('npm global package');
    expect(disagreement?.message).not.toContain(home);
  });

  it('detects a non-installer npm install through an injected PATH', async () => {
    const home = await tempHome();
    const bin = await makeNpmInstall(home, '0.154.0');

    const detection = await detectCodex(home, bin);

    expect(detection.installed).toBe('yes');
    expect(detection.version).toBe('0.154.0');
    expect(detection.runtimeCompatibility).toBe('verified');
    expect(detection.diagnostics).toEqual([]);
  });

  it('detects a PATH-only install with an unknown version', async () => {
    const home = await tempHome();
    const bin = join(home, 'custom-bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'codex'), '');

    const detection = await detectCodex(home, bin);

    expect(detection.installed).toBe('yes');
    expect(detection.version).toBeNull();
    expect(detection.diagnostics.map((d) => d.code)).toContain('runtime-version-unknown');
  });

  it('does not traverse a symlinked PATH entry', async () => {
    const home = await tempHome();
    const target = join(home, 'real-bin');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'codex'), '');
    const link = join(home, 'link-bin');
    await symlink(target, link);

    const detection = await detectCodex(home, link);

    expect(detection.installed).toBe('no');
  });

  it('does not traverse a symlinked PATH ancestor', async () => {
    const home = await tempHome();
    const real = join(home, 'real-parent');
    await mkdir(join(real, 'bin'), { recursive: true });
    await writeFile(join(real, 'bin', 'codex'), '');
    await symlink(real, join(home, 'link-parent'));

    const detection = await detectCodex(home, join(home, 'link-parent', 'bin'));

    expect(detection.installed).toBe('no');
  });

  it('does not traverse a symlinked install ancestor', async () => {
    const home = await tempHome();
    const outside = join(home, 'outside');
    await mkdir(join(outside, 'standalone', 'releases', '0.154.0-aarch64-apple-darwin'), {
      recursive: true,
    });
    await mkdir(join(home, '.codex'), { recursive: true });
    await symlink(outside, join(home, '.codex', 'packages'));

    const detection = await detectCodex(home, '');

    expect(detection.version).toBeNull();
  });
});
