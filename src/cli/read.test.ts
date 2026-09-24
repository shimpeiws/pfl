import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_CODES } from './exit-codes.js';
import { generateObservedSnapshotId, runtimeId, type ResolvedSnapshotId } from '../core/ids.js';
import type { ObservedSnapshot } from '../core/observed.js';
import type { ResolvedSnapshot } from '../core/resolved.js';
import { resolveProjectContext } from '../discovery/project-identity.js';
import {
  writeLatestPointer,
  writeObservedSnapshot,
  writeResolvedSnapshot,
} from '../snapshot/store.js';
import { loadInterpretation } from './read.js';

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Writes one run (observed + resolved) for a runtime; returns its ids. */
async function seedRun(
  projectRoot: string,
  home: string,
  runtime: string,
  capturedAt: string,
  resolvedId: string,
): Promise<{ observedId: string; resolvedId: string }> {
  const projectId = (await resolveProjectContext(projectRoot)).id;
  const observed: ObservedSnapshot = {
    schemaVersion: '1',
    snapshotId: generateObservedSnapshotId(),
    capturedAt,
    project: { id: projectId, displayName: 'owner/repo', root: projectRoot },
    runtime: { id: runtimeId(runtime), version: '1.0.0' },
    adapter: { id: runtime, version: '0.1.0', runtimeCompatibility: 'verified' },
    elements: [],
    diagnostics: [],
    completeness: 'complete',
    digests: { observed: 'sha256:x' },
  };
  const resolved: ResolvedSnapshot = {
    schemaVersion: '1',
    snapshotId: resolvedId as ResolvedSnapshotId,
    observedSnapshotId: observed.snapshotId,
    runtime: { id: runtimeId(runtime), version: '1.0.0' },
    resolution: { semanticsVersion: '1', confidence: 'verified' },
    elements: [],
    relations: [],
    effectiveElementIds: [],
    diagnostics: [],
    digests: { harnessContent: 'sha256:h', resolvedSnapshot: 'sha256:r' },
  };
  await writeObservedSnapshot(projectId, observed, home);
  await writeResolvedSnapshot(projectId, resolved, home);
  await writeLatestPointer(
    projectId,
    { observed: observed.snapshotId, resolved: resolved.snapshotId },
    home,
  );
  return { observedId: observed.snapshotId, resolvedId: resolved.snapshotId };
}

describe('loadInterpretation --runtime', () => {
  it('scopes latest to the newest run of the requested runtime', async () => {
    const projectRoot = await tempDir('pfl-read-project-');
    const home = await tempDir('pfl-read-home-');
    // codex was inspected earlier, then claude-code — the latest pointer names
    // claude-code, but a runtime-scoped read must answer codex.
    await seedRun(projectRoot, home, 'codex', '2026-09-20T00:00:00.000Z', 'res_codex');
    await seedRun(projectRoot, home, 'claude-code', '2026-09-21T00:00:00.000Z', 'res_claude');

    const scoped = await loadInterpretation(projectRoot, undefined, home, 'codex');
    expect(scoped.resolved.snapshotId).toBe('res_codex');
    expect(scoped.observed.runtime.id).toBe(runtimeId('codex'));

    const unscoped = await loadInterpretation(projectRoot, undefined, home);
    expect(unscoped.resolved.snapshotId).toBe('res_claude');
  });

  it('accepts the literal `latest` with a runtime scope', async () => {
    const projectRoot = await tempDir('pfl-read-project-');
    const home = await tempDir('pfl-read-home-');
    await seedRun(projectRoot, home, 'codex', '2026-09-20T00:00:00.000Z', 'res_codex');
    await seedRun(projectRoot, home, 'claude-code', '2026-09-21T00:00:00.000Z', 'res_claude');

    const run = await loadInterpretation(projectRoot, 'latest', home, 'codex');
    expect(run.resolved.snapshotId).toBe('res_codex');
  });

  it('fails when the runtime has no stored snapshot', async () => {
    const projectRoot = await tempDir('pfl-read-project-');
    const home = await tempDir('pfl-read-home-');
    await seedRun(projectRoot, home, 'claude-code', '2026-09-21T00:00:00.000Z', 'res_claude');

    await expect(loadInterpretation(projectRoot, undefined, home, 'codex')).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
      message: expect.stringContaining('codex'),
    });
  });

  it('refuses a named snapshot from another runtime', async () => {
    const projectRoot = await tempDir('pfl-read-project-');
    const home = await tempDir('pfl-read-home-');
    await seedRun(projectRoot, home, 'codex', '2026-09-20T00:00:00.000Z', 'res_codex');
    await seedRun(projectRoot, home, 'claude-code', '2026-09-21T00:00:00.000Z', 'res_claude');

    await expect(
      loadInterpretation(projectRoot, 'res_claude', home, 'codex'),
    ).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
      message: expect.stringContaining('claude-code'),
    });
  });
});
