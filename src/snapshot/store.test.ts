import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_CODES, PflError } from '../cli/exit-codes.js';
import { generateObservedSnapshotId, runtimeId } from '../core/ids.js';
import type { ObservedSnapshot } from '../core/observed.js';
import { serializeSnapshot } from './serialization.js';
import {
  interpretationsDir,
  latestPath,
  listSnapshots,
  observationsDir,
  permissionsPath,
  pflHome,
  projectDir,
  readInterpretation,
  readLatestSnapshotId,
  readObservation,
  readSnapshot,
  snapshotsDir,
  writeLatestSnapshotId,
  writeSnapshot,
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

function makeSnapshot(overrides: Partial<ObservedSnapshot> = {}): ObservedSnapshot {
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

describe('writeSnapshot / readSnapshot', () => {
  it('round-trips a snapshot', async () => {
    const home = await tempHome();
    const snapshot = makeSnapshot();

    await writeSnapshot('proj', snapshot, home);

    await expect(readSnapshot('proj', snapshot.snapshotId, home)).resolves.toEqual(snapshot);
  });

  it('refuses to overwrite an existing id and leaves the original bytes untouched', async () => {
    const home = await tempHome();
    const snapshot = makeSnapshot();
    await writeSnapshot('proj', snapshot, home);
    const file = join(snapshotsDir('proj', home), `${snapshot.snapshotId}.json`);
    const before = await readFile(file, 'utf8');

    const conflicting = makeSnapshot({ snapshotId: snapshot.snapshotId, capturedAt: 'later' });
    await expect(writeSnapshot('proj', conflicting, home)).rejects.toThrowError(PflError);

    await expect(writeSnapshot('proj', conflicting, home)).rejects.toMatchObject({
      exitCode: EXIT_CODES.SNAPSHOT_STORE_FAILED,
    });
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await readdir(snapshotsDir('proj', home))).some((name) => name.endsWith('.tmp'))).toBe(
      false,
    );
  });

  it('rejects a snapshot file that is only a schema version', async () => {
    const home = await tempHome();
    await mkdir(snapshotsDir('proj', home), { recursive: true });
    await writeFile(join(snapshotsDir('proj', home), 'obs_sparse.json'), '{"schemaVersion":"1"}\n');

    await expect(readSnapshot('proj', 'obs_sparse', home)).rejects.toThrowError(PflError);
  });
  it('leaves no temp file behind', async () => {
    const home = await tempHome();
    const snapshot = makeSnapshot();

    await writeSnapshot('proj', snapshot, home);

    expect(await readdir(snapshotsDir('proj', home))).toEqual([`${snapshot.snapshotId}.json`]);
  });

  it('creates the store with restrictive permissions', async () => {
    const home = await tempHome();
    const snapshot = makeSnapshot();

    await writeSnapshot('proj', snapshot, home);

    expect(((await stat(pflHome(home))).mode & 0o777).toString(8)).toBe('700');
    expect(((await stat(snapshotsDir('proj', home))).mode & 0o777).toString(8)).toBe('700');
    expect(
      (
        (await stat(join(snapshotsDir('proj', home), `${snapshot.snapshotId}.json`))).mode & 0o777
      ).toString(8),
    ).toBe('600');
  });
});

describe('boundary validation', () => {
  it('rejects ids that would escape the store', async () => {
    const home = await tempHome();

    expect(() => projectDir('../evil', home)).toThrowError(PflError);
    expect(() => snapshotsDir('a/b', home)).toThrowError(PflError);
    await expect(readSnapshot('proj', '../../etc/passwd', home)).rejects.toThrowError(PflError);
    await expect(readSnapshot('proj', 'a/b', home)).rejects.toThrowError(PflError);
    await expect(readLatestSnapshotId('../evil', home)).rejects.toThrowError(PflError);
  });

  it('reports an unreadable store instead of pretending it is empty', async () => {
    const home = await tempHome();
    await mkdir(projectDir('proj', home), { recursive: true });
    await writeFile(snapshotsDir('proj', home), 'not a directory');

    const { diagnostics } = await listSnapshots('proj', home);

    expect(diagnostics.map((entry) => entry.code)).toContain('snapshot-store-unreadable');
  });

  it('throws on a non-ENOENT error reading the latest pointer', async () => {
    const home = await tempHome();
    await mkdir(latestPath('proj', home), { recursive: true });

    await expect(readLatestSnapshotId('proj', home)).rejects.toThrowError(PflError);
  });
});

describe('latest pointer', () => {
  it('is null until written, then resolves to the id', async () => {
    const home = await tempHome();
    expect(await readLatestSnapshotId('proj', home)).toBeNull();

    await writeLatestSnapshotId('proj', 'obs_abc', home);

    expect(await readLatestSnapshotId('proj', home)).toBe('obs_abc');
  });

  it('is mutable and replaced on the next write', async () => {
    const home = await tempHome();
    await writeLatestSnapshotId('proj', 'obs_one', home);
    await writeLatestSnapshotId('proj', 'obs_two', home);

    expect(await readLatestSnapshotId('proj', home)).toBe('obs_two');
    expect(await readdir(projectDir('proj', home))).not.toContain('latest.tmp');
  });
});

describe('read-by-id for the other layers', () => {
  it('reads an observation from observations/', async () => {
    const home = await tempHome();
    const snapshot = makeSnapshot();
    await mkdir(observationsDir('proj', home), { recursive: true });
    await writeFile(
      join(observationsDir('proj', home), 'obs_event.json'),
      serializeSnapshot(snapshot),
    );

    await expect(readObservation('proj', 'obs_event', home)).resolves.toEqual(snapshot);
  });

  it('reads an interpretation from interpretations/', async () => {
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

describe('listSnapshots', () => {
  it('returns nothing for a project with no snapshots', async () => {
    const home = await tempHome();
    await expect(listSnapshots('proj', home)).resolves.toEqual({ snapshots: [], diagnostics: [] });
  });

  it('lists snapshots newest first', async () => {
    const home = await tempHome();
    const older = makeSnapshot({ capturedAt: '2026-01-01T00:00:00.000Z' });
    const newer = makeSnapshot({ capturedAt: '2026-02-01T00:00:00.000Z' });
    await writeSnapshot('proj', older, home);
    await writeSnapshot('proj', newer, home);

    const { snapshots } = await listSnapshots('proj', home);

    expect(snapshots.map((entry) => entry.id)).toEqual([newer.snapshotId, older.snapshotId]);
    expect(snapshots[0]).toMatchObject({
      capturedAt: '2026-02-01T00:00:00.000Z',
      runtime: { id: 'claude-code', version: '2.1.272' },
      completeness: 'complete',
    });
  });

  it('records an unreadable snapshot as a diagnostic instead of failing', async () => {
    const home = await tempHome();
    await mkdir(snapshotsDir('proj', home), { recursive: true });
    await writeFile(join(snapshotsDir('proj', home), 'obs_bad.json'), '{ not json');

    const { snapshots, diagnostics } = await listSnapshots('proj', home);

    expect(snapshots).toEqual([]);
    expect(diagnostics.map((entry) => entry.code)).toEqual(['unreadable-snapshot']);
  });
});
