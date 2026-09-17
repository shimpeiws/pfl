import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  generateInterpretationId,
  generateObservedSnapshotId,
  generateResolvedSnapshotId,
  runtimeId,
} from '../core/ids.js';
import type { Interpretation } from '../core/interpretation.js';
import type { ObservedSnapshot } from '../core/observed.js';
import type { ResolvedSnapshot } from '../core/resolved.js';
import { resolveProjectContext } from '../discovery/project-identity.js';
import { writeProjectIndex } from '../snapshot/project-index.js';
import {
  interpretationsDir,
  observationsDir,
  projectDir,
  snapshotsDir,
  writeInterpretation,
  writeLatestPointer,
  writeObservedSnapshot,
  writeResolvedSnapshot,
  type StoredRunSummary,
} from '../snapshot/store.js';
import type { Logger } from '../util/logger.js';
import { planRetention, runGc } from './gc.js';

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

interface RunIds {
  observedId: string;
  resolvedId: string;
  interpretationId: string;
}

async function seedRun(home: string, projectId: string, capturedAt: string): Promise<RunIds> {
  const observedId = generateObservedSnapshotId();
  const resolvedId = generateResolvedSnapshotId();
  const interpretationId = generateInterpretationId();
  const observed: ObservedSnapshot = {
    schemaVersion: '1',
    snapshotId: observedId,
    capturedAt,
    project: { id: projectId, displayName: 'owner/repo', root: '/repo' },
    runtime: { id: runtimeId('claude-code'), version: '2.1.272' },
    adapter: { id: 'claude-code', version: '0.1.0', runtimeCompatibility: 'verified' },
    elements: [],
    diagnostics: [],
    completeness: 'complete',
    digests: { observed: 'sha256:abc' },
  };
  const resolved: ResolvedSnapshot = {
    schemaVersion: '1',
    snapshotId: resolvedId,
    observedSnapshotId: observedId,
    runtime: { id: runtimeId('claude-code'), version: '2.1.272' },
    resolution: { semanticsVersion: '1', confidence: 'verified' },
    elements: [],
    relations: [],
    effectiveElementIds: [],
    diagnostics: [],
    digests: { harnessContent: 'sha256:c', resolvedSnapshot: 'sha256:r' },
  };
  const interpretation: Interpretation = {
    schemaVersion: '1',
    interpretationId,
    resolvedSnapshotId: resolvedId,
    classifier: { id: 'pfl-native', version: '4' },
    elements: [],
    stats: { observed: 0, effective: 0, shadowed: 0, conditional: 0, opaque: 0, byFacet: {} },
    findings: [],
  };
  await writeObservedSnapshot(projectId, observed, home);
  await writeResolvedSnapshot(projectId, resolved, home);
  await writeInterpretation(projectId, interpretation, home);
  return { observedId, resolvedId, interpretationId };
}

function runPaths(home: string, projectId: string, run: RunIds): string[] {
  return [
    join(observationsDir(projectId, home), `${run.observedId}.json`),
    join(snapshotsDir(projectId, home), `${run.resolvedId}.json`),
    join(interpretationsDir(projectId, home), `${run.resolvedId}.json`),
  ];
}

function run(observedId: string): StoredRunSummary {
  return {
    observedId,
    resolvedId: `res_${observedId}`,
    interpretationId: `int_${observedId}`,
    capturedAt: '2026-01-01T00:00:00.000Z',
    runtime: { id: 'claude-code', version: null },
    completeness: 'complete',
  };
}

describe('planRetention', () => {
  it('keeps the newest runs and always keeps the latest, even when it points elsewhere', () => {
    const runs = [run('obs_1'), run('obs_2'), run('obs_3')];

    const normal = planRetention(runs, 'obs_1', 2);
    expect(normal.retained.map((entry) => entry.observedId)).toEqual(['obs_1', 'obs_2']);
    expect(normal.reclaimed.map((entry) => entry.observedId)).toEqual(['obs_3']);

    // latest points at the oldest run, which must survive in addition to the
    // newest `keep` runs.
    const pinned = planRetention(runs, 'obs_3', 1);
    expect(pinned.retained.map((entry) => entry.observedId)).toEqual(['obs_1', 'obs_3']);
    expect(pinned.reclaimed.map((entry) => entry.observedId)).toEqual(['obs_2']);
  });

  it('ignores a latest id that names no run', () => {
    const runs = [run('obs_1'), run('obs_2')];
    const result = planRetention(runs, 'obs_missing', 1);
    expect(result.retained.map((entry) => entry.observedId)).toEqual(['obs_1']);
  });
});

describe('runGc', () => {
  it('retains the newest runs, reclaims the rest as a unit, and always keeps latest', async () => {
    const projectRoot = await tempDir('pfl-gc-project-');
    const home = await tempDir('pfl-gc-home-');
    const projectId = (await resolveProjectContext(projectRoot)).id;
    const oldest = await seedRun(home, projectId, '2026-01-01T00:00:00.000Z');
    const middle = await seedRun(home, projectId, '2026-02-01T00:00:00.000Z');
    const newest = await seedRun(home, projectId, '2026-03-01T00:00:00.000Z');
    await writeLatestPointer(
      projectId,
      {
        observed: newest.observedId,
        resolved: newest.resolvedId,
        interpretation: newest.interpretationId,
      },
      home,
    );

    // A dry run plans the reclamation but deletes nothing.
    const planned = await runGc(projectRoot, { home, keep: 2, dryRun: true }, silent);
    expect(planned.data.retained.map((run) => run.observedId)).toEqual([
      newest.observedId,
      middle.observedId,
    ]);
    expect(planned.data.reclaimed.map((run) => run.observedId)).toEqual([oldest.observedId]);
    expect(await exists(runPaths(home, projectId, oldest)[0] as string)).toBe(true);

    const applied = await runGc(projectRoot, { home, keep: 2 }, silent);
    expect(applied.data.reclaimed.map((run) => run.observedId)).toEqual([oldest.observedId]);
    for (const path of runPaths(home, projectId, oldest)) {
      expect(await exists(path), path).toBe(false);
    }
    for (const run of [middle, newest]) {
      for (const path of runPaths(home, projectId, run)) {
        expect(await exists(path), path).toBe(true);
      }
    }
  });

  it('clamps --keep below one so the latest run survives', async () => {
    const projectRoot = await tempDir('pfl-gc-project-');
    const home = await tempDir('pfl-gc-home-');
    const projectId = (await resolveProjectContext(projectRoot)).id;
    const older = await seedRun(home, projectId, '2026-01-01T00:00:00.000Z');
    const latest = await seedRun(home, projectId, '2026-02-01T00:00:00.000Z');
    await writeLatestPointer(
      projectId,
      {
        observed: latest.observedId,
        resolved: latest.resolvedId,
        interpretation: latest.interpretationId,
      },
      home,
    );

    const outcome = await runGc(projectRoot, { home, keep: 0 }, silent);

    expect(outcome.data.keep).toBe(1);
    expect(outcome.data.retained.map((run) => run.observedId)).toEqual([latest.observedId]);
    expect(await exists(runPaths(home, projectId, older)[0] as string)).toBe(false);
    expect(await exists(runPaths(home, projectId, latest)[0] as string)).toBe(true);
  });

  it('reclaims a root-gone history but never an unreferenced one', async () => {
    const projectRoot = await tempDir('pfl-gc-project-');
    const home = await tempDir('pfl-gc-home-');
    // Unreferenced: the index has no entry, so its root is unknown and it must
    // not be destroyed (it may be a history not yet adopted).
    const unclaimed = 'orphan-dir1';
    // Orphan: the index names it, but every root it claims is gone.
    const rootGone = 'orphan-dir2';
    await mkdir(projectDir(unclaimed, home), { recursive: true });
    await mkdir(projectDir(rootGone, home), { recursive: true });
    await writeProjectIndex(
      { indexVersion: '1', projects: { '/a/root/that/is/gone': rootGone } },
      home,
    );

    const listed = await runGc(projectRoot, { home }, silent);
    expect(listed.data.orphans.map((orphan) => orphan.id)).toEqual([rootGone]);
    expect(listed.data.unreferenced.map((entry) => entry.id)).toEqual([unclaimed]);
    expect(listed.data.orphansReclaimed).toBe(false);

    // A dry run with --prune-orphans still deletes nothing.
    const dry = await runGc(projectRoot, { home, pruneOrphans: true, dryRun: true }, silent);
    expect(dry.data.orphansReclaimed).toBe(false);
    expect(await exists(projectDir(rootGone, home))).toBe(true);

    const pruned = await runGc(projectRoot, { home, pruneOrphans: true }, silent);
    expect(pruned.data.orphansReclaimed).toBe(true);
    expect(await exists(projectDir(rootGone, home))).toBe(false);
    expect(await exists(projectDir(unclaimed, home))).toBe(true);
  });

  it('reclaims the interpretation even when it could not be parsed', async () => {
    const projectRoot = await tempDir('pfl-gc-project-');
    const home = await tempDir('pfl-gc-home-');
    const projectId = (await resolveProjectContext(projectRoot)).id;
    const older = await seedRun(home, projectId, '2026-01-01T00:00:00.000Z');
    const newer = await seedRun(home, projectId, '2026-02-01T00:00:00.000Z');
    await writeLatestPointer(
      projectId,
      {
        observed: newer.observedId,
        resolved: newer.resolvedId,
        interpretation: newer.interpretationId,
      },
      home,
    );
    // Corrupt the older interpretation: `listRuns` then reports it and leaves
    // the run's `interpretationId` null, but the file still belongs to the run.
    await writeFile(
      join(interpretationsDir(projectId, home), `${older.resolvedId}.json`),
      '{ not json',
    );
    // A stray unparseable observation that belongs to no run is reported, not deleted.
    await writeFile(join(observationsDir(projectId, home), 'obs_broken.json'), '{ not json');

    const outcome = await runGc(projectRoot, { home, keep: 1 }, silent);

    for (const path of runPaths(home, projectId, older)) {
      expect(await exists(path), path).toBe(false);
    }
    expect(await exists(join(observationsDir(projectId, home), 'obs_broken.json'))).toBe(true);
    expect(outcome.diagnostics.map((entry) => entry.code)).toContain('invalid-snapshot');
  });
});
