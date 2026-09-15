import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectClaudeCode } from './detect.js';

const tempDirs: string[] = [];

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pfl-claude-detect-'));
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

describe('detectClaudeCode', () => {
  it('reports a present, verified installation', async () => {
    const home = await tempHome();
    await writeUpdateResult(home, '2.1.100');

    const detection = await detectClaudeCode(home);

    expect(detection.installed).toBe(true);
    expect(detection.version).toBe('2.1.100');
    expect(detection.runtimeCompatibility).toBe('verified');
    expect(detection.diagnostics).toEqual([]);
  });

  it('reports a present-but-newer installation as unverified without failing', async () => {
    const home = await tempHome();
    await writeUpdateResult(home, '2.2.0');

    const detection = await detectClaudeCode(home);

    expect(detection.installed).toBe(true);
    expect(detection.version).toBe('2.2.0');
    expect(detection.runtimeCompatibility).toBe('unverified');
    expect(detection.diagnostics.map((d) => d.code)).toContain('runtime-version-unverified');
  });

  it('reports present-but-version-unreadable with a null version', async () => {
    const home = await tempHome();
    await mkdir(join(home, '.claude'), { recursive: true });

    const detection = await detectClaudeCode(home);

    expect(detection.installed).toBe(true);
    expect(detection.version).toBeNull();
    expect(detection.runtimeCompatibility).toBe('unverified');
    expect(detection.diagnostics.map((d) => d.code)).toContain('runtime-version-unknown');
  });

  it('reports an absent installation', async () => {
    const home = await tempHome();

    const detection = await detectClaudeCode(home);

    expect(detection.installed).toBe(false);
    expect(detection.version).toBeNull();
    expect(detection.runtimeCompatibility).toBe('unverified');
    expect(detection.diagnostics.map((d) => d.code)).toContain('runtime-not-found');
  });

  it('falls back to the versions directory, taking the highest', async () => {
    const home = await tempHome();
    await mkdir(join(home, '.local', 'share', 'claude', 'versions'), { recursive: true });
    await writeFile(join(home, '.local', 'share', 'claude', 'versions', '2.1.50'), '');
    await writeFile(join(home, '.local', 'share', 'claude', 'versions', '2.1.60'), '');

    const detection = await detectClaudeCode(home);

    expect(detection.version).toBe('2.1.60');
    expect(detection.runtimeCompatibility).toBe('verified');
  });
});
