import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_CODES, PflError } from '../cli/exit-codes.js';
import {
  generateObservedSnapshotId,
  generateResolvedSnapshotId,
  runtimeId,
  type ObservedSnapshotId,
} from '../core/ids.js';
import type { ObservedSnapshot } from '../core/observed.js';
import type { ResolvedSnapshot } from '../core/resolved.js';
import { serializeSnapshot } from './serialization.js';
import {
  interpretationsDir,
  latestPath,
  listRuns,
  observationsDir,
  permissionsPath,
  pflHome,
  projectDir,
  readInterpretation,
  readLatestPointer,
  readObservedSnapshot,
  readResolvedSnapshot,
  snapshotsDir,
  writeLatestPointer,
  writeObservedSnapshot,
  writeResolvedSnapshot,
} from './store.js';

const tempDirs: string[] = [];

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pfl-store-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeObserved(overrides: Partial<ObservedSnapshot> = {}): ObservedSnapshot {
  return {
    schemaVersion: '1',
    snapshotId: generateObservedSnapshotId(),
    capturedAt: '2026-09-16T00:00:00.000Z',
    project: { id: 'proj', displayName: 'owner/repo', root: '/repo' },
    runtime: { id: runtimeId('claude-code'), version: '2.1.272' },
    adapter: { id: 'claude-code', version: '0.1.0', runtimeCompatibility: 'verified' },
    elements: [],
    diagnostics: [],
    completeness: 'complete',
    digests: { observed: 'sha256:abc' },
    ...overrides,
  };
}

function makeResolved(observedSnapshotId: ObservedSnapshotId): ResolvedSnapshot {
  return {
    schemaVersion: '1',
    snapshotId: generateResolvedSnapshotId(),
    observedSnapshotId,
    runtime: { id: runtimeId('claude-code'), version: '2.1.272' },
    resolution: { semanticsVersion: '1', confidence: 'verified' },
    elements: [],
    relations: [],
    effectiveElementIds: [],
    diagnostics: [],
    digests: { harnessContent: 'sha256:content', resolvedSnapshot: 'sha256:resolved' },
  };
}

describe('path helpers', () => {
  it('derive every path from the injected home', () => {
    const home = '/home/u';
    expect(pflHome(home)).toBe('/home/u/.pfl');
    expect(permissionsPath(home)).toBe('/home/u/.pfl/permissions.json');
    expect(projectDir('p', home)).toBe('/home/u/.pfl/projects/p');
    expect(observationsDir('p', home)).toBe('/home/u/.pfl/projects/p/observations');
    expect(snapshotsDir('p', home)).toBe('/home/u/.pfl/projects/p/snapshots');
    expect(interpretationsDir('p', home)).toBe('/home/u/.pfl/projects/p/interpretations');
    expect(latestPath('p', home)).toBe('/home/u/.pfl/projects/p/latest');
  });
});

describe('observed snapshots', () => {
  it('round-trips into observations/', async () => {
    const home = await tempHome();
    const snapshot = makeObserved();

    await writeObservedSnapshot('proj', snapshot, home);

    await expect(readObservedSnapshot('proj', snapshot.snapshotId, home)).resolves.toEqual(
      snapshot,
    );
    expect(await readdir(observationsDir('proj', home))).toEqual([`${snapshot.snapshotId}.json`]);
  });

  it('refuses to overwrite an existing id and leaves the original bytes untouched', async () => {
    const home = await tempHome();
    const snapshot = makeObserved();
    await writeObservedSnapshot('proj', snapshot, home);
    const file = join(observationsDir('proj', home), `${snapshot.snapshotId}.json`);
    const before = await readFile(file, 'utf8');

    const conflicting = makeObserved({ snapshotId: snapshot.snapshotId, capturedAt: 'later' });
    await expect(writeObservedSnapshot('proj', conflicting, home)).rejects.toMatchObject({
      exitCode: EXIT_CODES.SNAPSHOT_STORE_FAILED,
    });

    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await readdir(observationsDir('proj', home))).some((n) => n.endsWith('.tmp'))).toBe(
      false,
    );
  });

  it('creates the store with restrictive permissions', async () => {
    const home = await tempHome();
    const snapshot = makeObserved();

    await writeObservedSnapshot('proj', snapshot, home);

    expect(((await stat(pflHome(home))).mode & 0o777).toString(8)).toBe('700');
    expect(
      (
        (await stat(join(observationsDir('proj', home), `${snapshot.snapshotId}.json`))).mode &
        0o777
      ).toString(8),
    ).toBe('600');
  });

  it('rejects a snapshot file that is only a schema version', async () => {
    const home = await tempHome();
    await mkdir(observationsDir('proj', home), { recursive: true });
    await writeFile(
      join(observationsDir('proj', home), 'obs_sparse.json'),
      '{"schemaVersion":"1"}\n',
    );

    await expect(readObservedSnapshot('proj', 'obs_sparse', home)).rejects.toThrowError(PflError);
  });
});

describe('resolved snapshots', () => {
  it('round-trips into snapshots/', async () => {
    const home = await tempHome();
    const observed = makeObserved();
    const resolved = makeResolved(observed.snapshotId);

    await writeResolvedSnapshot('proj', resolved, home);

    await expect(readResolvedSnapshot('proj', resolved.snapshotId, home)).resolves.toEqual(
      resolved,
    );
    expect(await readdir(snapshotsDir('proj', home))).toEqual([`${resolved.snapshotId}.json`]);
  });
});

describe('latest pointer', () => {
  it('is null until written, then resolves to both ids', async () => {
    const home = await tempHome();
    expect(await readLatestPointer('proj', home)).toBeNull();

    await writeLatestPointer('proj', { observed: 'obs_a', resolved: 'res_a' }, home);

    expect(await readLatestPointer('proj', home)).toEqual({ observed: 'obs_a', resolved: 'res_a' });
  });
});

describe('listRuns', () => {
  it('joins each observation with its resolved snapshot, newest first', async () => {
    const home = await tempHome();
    const older = makeObserved({ capturedAt: '2026-01-01T00:00:00.000Z' });
    const newer = makeObserved({ capturedAt: '2026-02-01T00:00:00.000Z' });
    await writeObservedSnapshot('proj', older, home);
    await writeObservedSnapshot('proj', newer, home);
    await writeResolvedSnapshot('proj', makeResolved(newer.snapshotId), home);

    const { runs } = await listRuns('proj', home);

    expect(runs.map((run) => run.observedId)).toEqual([newer.snapshotId, older.snapshotId]);
    expect(runs[0]?.resolvedId).toMatch(/^res_/);
    expect(runs[1]?.resolvedId).toBeNull();
    expect(runs[0]).toMatchObject({
      capturedAt: '2026-02-01T00:00:00.000Z',
      runtime: { id: 'claude-code', version: '2.1.272' },
      completeness: 'complete',
    });
  });

  it('records an unreadable observation as a diagnostic instead of failing', async () => {
    const home = await tempHome();
    await mkdir(observationsDir('proj', home), { recursive: true });
    await writeFile(join(observationsDir('proj', home), 'obs_bad.json'), '{ not json');

    const { runs, diagnostics } = await listRuns('proj', home);

    expect(runs).toEqual([]);
    expect(diagnostics.map((entry) => entry.code)).toContain('unreadable-observation');
  });
});

describe('readInterpretation', () => {
  it('reads from interpretations/', async () => {
    const home = await tempHome();
    await mkdir(interpretationsDir('proj', home), { recursive: true });
    await writeFile(
      join(interpretationsDir('proj', home), 'int_x.json'),
      serializeSnapshot({
        schemaVersion: '1',
        interpretationId: 'int_x',
        resolvedSnapshotId: 'res_y',
        classifier: { id: 'classifier', version: '1' },
        elements: [],
        stats: {},
        findings: [],
      }),
    );

    await expect(readInterpretation('proj', 'int_x', home)).resolves.toMatchObject({
      interpretationId: 'int_x',
    });
  });
});

describe('boundary validation', () => {
  it('rejects ids that would escape the store', async () => {
    const home = await tempHome();

    expect(() => projectDir('../evil', home)).toThrowError(PflError);
    expect(() => snapshotsDir('a/b', home)).toThrowError(PflError);
    await expect(readObservedSnapshot('proj', '../../etc/passwd', home)).rejects.toThrowError(
      PflError,
    );
    await expect(
      writeLatestPointer('proj', { observed: '../x', resolved: 'res_a' }, home),
    ).rejects.toThrowError(PflError);
  });
});
