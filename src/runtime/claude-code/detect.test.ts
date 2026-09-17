import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectClaudeCode } from './detect.js';

const tempDirs: string[] = [];

async function tempHome(): Promise<string> {
  // Canonicalised so the ancestor guard, which walks from the filesystem root,
  // is not tripped by macOS's `/var` symlink; a canonical temp root makes the
  // symlink tests exercise the intended component.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pfl-claude-detect-')));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeUpdateResult(home: string, versionTo: string): Promise<void> {
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(
    join(home, '.claude', '.last-update-result.json'),
    JSON.stringify({ version_from: '2.1.0', version_to: versionTo }),
  );
}

/** A bin directory holding `claude`, plus an npm layout under the same prefix. */
async function makeNpmInstall(home: string, version: string): Promise<string> {
  const prefix = join(home, 'npm-prefix');
  await mkdir(join(prefix, 'bin'), { recursive: true });
  await mkdir(join(prefix, 'lib', 'node_modules', '@anthropic-ai', 'claude-code'), {
    recursive: true,
  });
  await writeFile(join(prefix, 'bin', 'claude'), '');
  await writeFile(
    join(prefix, 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'),
    JSON.stringify({ version }),
  );
  return join(prefix, 'bin');
}

describe('detectClaudeCode', () => {
  it('reports a present, verified installation', async () => {
    const home = await tempHome();
    await writeUpdateResult(home, '2.1.100');

    const detection = await detectClaudeCode(home, '');

    expect(detection.installed).toBe('yes');
    expect(detection.version).toBe('2.1.100');
    expect(detection.runtimeCompatibility).toBe('verified');
    expect(detection.diagnostics).toEqual([]);
  });

  it('reports a newer-than-verified installation with the unverified diagnostic, without failing', async () => {
    const home = await tempHome();
    await writeUpdateResult(home, '2.2.0');

    const detection = await detectClaudeCode(home, '');

    expect(detection.installed).toBe('yes');
    expect(detection.version).toBe('2.2.0');
    expect(detection.runtimeCompatibility).toBe('unverified');
    expect(detection.diagnostics.map((d) => d.code)).toContain('runtime-version-unverified');
    expect(detection.diagnostics.map((d) => d.code)).not.toContain(
      'runtime-version-below-verified',
    );
  });

  it('reports an older-than-verified installation with a distinct diagnostic', async () => {
    const home = await tempHome();
    await writeUpdateResult(home, '2.0.9');

    const detection = await detectClaudeCode(home, '');

    expect(detection.installed).toBe('yes');
    expect(detection.version).toBe('2.0.9');
    expect(detection.runtimeCompatibility).toBe('unverified');
    expect(detection.diagnostics.map((d) => d.code)).toContain('runtime-version-below-verified');
    expect(detection.diagnostics.map((d) => d.code)).not.toContain('runtime-version-unverified');
  });

  it('reports present-but-version-unreadable with a null version', async () => {
    const home = await tempHome();
    const versions = join(home, '.local', 'share', 'claude', 'versions');
    await mkdir(versions, { recursive: true });
    await writeFile(join(versions, 'not-a-version'), '');

    const detection = await detectClaudeCode(home, '');

    expect(detection.installed).toBe('yes');
    expect(detection.version).toBeNull();
    expect(detection.runtimeCompatibility).toBe('unverified');
    expect(detection.diagnostics.map((d) => d.code)).toContain('runtime-version-unknown');
  });

  it('does not treat a bare config directory as installed', async () => {
    const home = await tempHome();
    await mkdir(join(home, '.claude'), { recursive: true });

    const detection = await detectClaudeCode(home, '');

    expect(detection.installed).toBe('no');
  });

  it('reports an absent installation', async () => {
    const home = await tempHome();

    const detection = await detectClaudeCode(home, '');

    expect(detection.installed).toBe('no');
    expect(detection.version).toBeNull();
    expect(detection.runtimeCompatibility).toBe('unverified');
    expect(detection.diagnostics.map((d) => d.code)).toContain('runtime-not-found');
  });

  it('falls back to the versions directory, taking the highest', async () => {
    const home = await tempHome();
    await mkdir(join(home, '.local', 'share', 'claude', 'versions'), { recursive: true });
    await writeFile(join(home, '.local', 'share', 'claude', 'versions', '2.1.50'), '');
    await writeFile(join(home, '.local', 'share', 'claude', 'versions', '2.1.60'), '');

    const detection = await detectClaudeCode(home, '');

    expect(detection.version).toBe('2.1.60');
    expect(detection.runtimeCompatibility).toBe('verified');
  });

  it('names disagreeing installer sources and picks the highest', async () => {
    const home = await tempHome();
    await writeUpdateResult(home, '2.1.100');
    await mkdir(join(home, '.local', 'share', 'claude', 'versions'), { recursive: true });
    await writeFile(join(home, '.local', 'share', 'claude', 'versions', '2.1.200'), '');

    const detection = await detectClaudeCode(home, '');
    const disagreement = detection.diagnostics.find(
      (d) => d.code === 'runtime-version-disagreement',
    );

    expect(detection.version).toBe('2.1.200');
    expect(disagreement).toBeDefined();
    expect(disagreement?.message).toContain('installer update metadata');
    expect(disagreement?.message).toContain('installer versions directory');
    // The diagnostic names the sources, not the machine: no raw path leaks.
    expect(disagreement?.message).not.toContain(home);
  });

  it('detects a non-installer npm install through an injected PATH', async () => {
    const home = await tempHome();
    const bin = await makeNpmInstall(home, '2.1.50');

    const detection = await detectClaudeCode(home, bin);

    expect(detection.installed).toBe('yes');
    expect(detection.version).toBe('2.1.50');
    expect(detection.runtimeCompatibility).toBe('verified');
    expect(detection.diagnostics).toEqual([]);
  });

  it('detects a PATH-only install with an unknown version', async () => {
    const home = await tempHome();
    const bin = join(home, 'custom-bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'claude'), '');

    const detection = await detectClaudeCode(home, bin);

    expect(detection.installed).toBe('yes');
    expect(detection.version).toBeNull();
    expect(detection.diagnostics.map((d) => d.code)).toContain('runtime-version-unknown');
  });

  it('detects a Homebrew install and reads the Cellar version', async () => {
    const home = await tempHome();
    const prefix = join(home, 'homebrew');
    await mkdir(join(prefix, 'bin'), { recursive: true });
    await mkdir(join(prefix, 'Cellar', 'claude-code', '2.1.42', 'bin'), { recursive: true });
    await writeFile(join(prefix, 'bin', 'claude'), '');

    const detection = await detectClaudeCode(home, join(prefix, 'bin'));

    expect(detection.installed).toBe('yes');
    expect(detection.version).toBe('2.1.42');
    expect(detection.runtimeCompatibility).toBe('verified');
  });

  it('does not follow a symlinked npm manifest', async () => {
    const home = await tempHome();
    const prefix = join(home, 'npm-prefix');
    await mkdir(join(prefix, 'bin'), { recursive: true });
    await mkdir(join(prefix, 'lib', 'node_modules', '@anthropic-ai', 'claude-code'), {
      recursive: true,
    });
    await writeFile(join(prefix, 'bin', 'claude'), '');
    const outside = join(home, 'outside-package.json');
    await writeFile(outside, JSON.stringify({ version: '2.1.50' }));
    await symlink(
      outside,
      join(prefix, 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'),
    );

    const detection = await detectClaudeCode(home, join(prefix, 'bin'));

    expect(detection.installed).toBe('yes');
    expect(detection.version).toBeNull();
  });

  it('does not read a symlinked Homebrew formula directory', async () => {
    const home = await tempHome();
    const prefix = join(home, 'homebrew');
    await mkdir(join(prefix, 'bin'), { recursive: true });
    await mkdir(join(prefix, 'Cellar'), { recursive: true });
    const outside = join(home, 'outside-cellar');
    await mkdir(join(outside, '2.1.42'), { recursive: true });
    await symlink(outside, join(prefix, 'Cellar', 'claude-code'));
    await writeFile(join(prefix, 'bin', 'claude'), '');

    const detection = await detectClaudeCode(home, join(prefix, 'bin'));

    expect(detection.installed).toBe('yes');
    expect(detection.version).toBeNull();
  });

  it('detects a symlinked launcher without resolving it', async () => {
    const home = await tempHome();
    const bin = join(home, 'bin');
    await mkdir(bin, { recursive: true });
    // A dangling link: the launcher is seen by name, but there is nothing to
    // follow and no version to read.
    await symlink(join(home, 'nowhere'), join(bin, 'claude'));

    const detection = await detectClaudeCode(home, bin);

    expect(detection.installed).toBe('yes');
    expect(detection.version).toBeNull();
  });

  it('does not traverse a symlinked PATH entry', async () => {
    const home = await tempHome();
    const target = join(home, 'real-bin');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'claude'), '');
    const link = join(home, 'link-bin');
    await symlink(target, link);

    const detection = await detectClaudeCode(home, link);

    expect(detection.installed).toBe('no');
  });

  it('does not traverse a symlinked PATH ancestor', async () => {
    const home = await tempHome();
    const real = join(home, 'real-parent');
    await mkdir(join(real, 'bin'), { recursive: true });
    await writeFile(join(real, 'bin', 'claude'), '');
    await symlink(real, join(home, 'link-parent'));

    const detection = await detectClaudeCode(home, join(home, 'link-parent', 'bin'));

    expect(detection.installed).toBe('no');
  });

  it('does not follow a symlinked versions directory', async () => {
    const home = await tempHome();
    const outside = join(home, 'outside-versions');
    await mkdir(join(home, '.local', 'share', 'claude'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, '2.1.100'), '');
    await symlink(outside, join(home, '.local', 'share', 'claude', 'versions'));

    const detection = await detectClaudeCode(home, '');

    expect(detection.installed).toBe('yes');
    expect(detection.version).toBeNull();
  });

  it('does not hang on a FIFO last-update-result file', async () => {
    const home = await tempHome();
    await mkdir(join(home, '.claude'), { recursive: true });
    await mkdir(join(home, '.local', 'share', 'claude'), { recursive: true });
    execFileSync('mkfifo', [join(home, '.claude', '.last-update-result.json')]);

    const detection = await detectClaudeCode(home, '');

    expect(detection.version).toBeNull();
  });

  it('does not traverse a symlinked install ancestor', async () => {
    const home = await tempHome();
    const outside = join(home, 'outside');
    await mkdir(join(outside, 'share', 'claude', 'versions'), { recursive: true });
    await writeFile(join(outside, 'share', 'claude', 'versions', '2.1.100'), '');
    await symlink(outside, join(home, '.local'));

    const detection = await detectClaudeCode(home, '');

    expect(detection.version).toBeNull();
  });
});
