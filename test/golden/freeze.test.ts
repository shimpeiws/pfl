import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDocument, buildErrorDocument, type Envelope } from '../../src/cli/document.js';
import { EXIT_CODES, PflError } from '../../src/cli/exit-codes.js';
import { runDiff } from '../../src/cli/diff.js';
import { runGc } from '../../src/cli/gc.js';
import { runGraph } from '../../src/cli/graph.js';
import { runInspect } from '../../src/cli/inspect.js';
import { runList } from '../../src/cli/list.js';
import { runReport } from '../../src/cli/report.js';
import { runShow } from '../../src/cli/show.js';
import { runSnapshots } from '../../src/cli/snapshots.js';
import { resolveProjectContext } from '../../src/discovery/project-identity.js';
import { projectIndexPath, readProjectIndex } from '../../src/snapshot/project-index.js';
import { serializeSnapshot } from '../../src/snapshot/serialization.js';
import {
  interpretationsDir,
  latestPath,
  observationsDir,
  readObservedSnapshot,
  snapshotsDir,
} from '../../src/snapshot/store.js';
import type { Logger } from '../../src/util/logger.js';
import { materialize } from '../fixtures/materialize.js';

/**
 * The schema-freeze golden files (roadmap M8 #88). A representative stored
 * snapshot and each command's `--json` document are captured here, so a change
 * to the persisted shape or the CLI contract moves a file a reviewer can see.
 *
 * Run with `UPDATE_GOLDEN=1` to rewrite the goldens after an intentional change;
 * CI compares and fails on any drift.
 */

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const GOLDEN_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(GOLDEN_DIR, '..', 'fixtures', 'schema');
const ELEMENT_ID = 'el_0123456789abcdef';
const OBSERVED_ID = 'obs_0123456789ab';
const RESOLVED_ID = 'res_0123456789ab';

let projectRoot = '';
let home = '';
let projectId = '';

afterAll(async () => {
  await Promise.all(
    [projectRoot, home].filter(Boolean).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

beforeAll(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'pfl-golden-project-'));
  home = await mkdtemp(join(tmpdir(), 'pfl-golden-home-'));
  projectId = (await resolveProjectContext(projectRoot)).id;
  await mkdir(observationsDir(projectId, home), { recursive: true });
  await mkdir(snapshotsDir(projectId, home), { recursive: true });
  await mkdir(interpretationsDir(projectId, home), { recursive: true });
  await writeFile(
    join(observationsDir(projectId, home), `${OBSERVED_ID}.json`),
    await readFile(join(FIXTURES, 'observed.json')),
  );
  await writeFile(
    join(snapshotsDir(projectId, home), `${RESOLVED_ID}.json`),
    await readFile(join(FIXTURES, 'resolved.json')),
  );
  await writeFile(
    join(interpretationsDir(projectId, home), `${RESOLVED_ID}.json`),
    await readFile(join(FIXTURES, 'interpretation.json')),
  );
  await writeFile(
    latestPath(projectId, home),
    `${JSON.stringify({ observed: OBSERVED_ID, resolved: RESOLVED_ID, interpretation: 'int_0123456789ab' })}\n`,
  );
});

function normalize(envelope: Envelope, extra: ReadonlyArray<readonly [string, string]> = []): unknown {
  // Replace the values that legitimately vary between runs: the package version,
  // random snapshot ids, and the temp project's id, root, and display name.
  let text = JSON.stringify(envelope);
  for (const [from, to] of [
    [projectId, 'PROJECT_ID'],
    [projectRoot, 'PROJECT_ROOT'],
    [basename(projectRoot), 'PROJECT_NAME'],
    ...extra,
  ] as ReadonlyArray<readonly [string, string]>) {
    if (from !== '') text = text.split(from).join(to);
  }
  text = text
    .replace(/"pflVersion":"[^"]*"/g, '"pflVersion":"VERSION"')
    .replace(/obs_[0-9a-f]{12}/g, 'obs_ID')
    .replace(/res_[0-9a-f]{12}/g, 'res_ID')
    .replace(/int_[0-9a-f]{12}/g, 'int_ID');
  return JSON.parse(text) as unknown;
}

async function golden(name: string, value: unknown): Promise<void> {
  const path = join(GOLDEN_DIR, `${name}.json`);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (process.env['UPDATE_GOLDEN'] === '1') {
    await writeFile(path, text);
    return;
  }
  expect(JSON.parse(await readFile(path, 'utf8')), name).toEqual(value);
}

const ctx = () => ({ home });

describe('frozen CLI documents', () => {
  it('captures report', async () => {
    const outcome = await runReport(projectRoot, { home }, silent);
    await golden('report', normalize(buildDocument('report', outcome, ctx())));
  });

  it('captures list', async () => {
    const outcome = await runList(projectRoot, { home }, silent);
    await golden('list', normalize(buildDocument('list', outcome, ctx())));
  });

  it('captures show', async () => {
    const outcome = await runShow(projectRoot, ELEMENT_ID, { home }, silent);
    await golden('show', normalize(buildDocument('show', outcome, ctx())));
  });

  it('captures graph', async () => {
    const outcome = await runGraph(projectRoot, { home }, silent);
    await golden('graph', normalize(buildDocument('graph', outcome, ctx())));
  });

  it('captures snapshots', async () => {
    const outcome = await runSnapshots(projectRoot, { home }, silent);
    await golden('snapshots', normalize(buildDocument('snapshots', outcome, ctx())));
  });

  it('captures a zero diff', async () => {
    const outcome = await runDiff(projectRoot, RESOLVED_ID, undefined, { home }, silent);
    await golden('diff', normalize(buildDocument('diff', outcome, ctx())));
  });

  it('captures gc', async () => {
    const outcome = await runGc(projectRoot, { home, dryRun: true }, silent);
    await golden('gc', normalize(buildDocument('gc', outcome, ctx())));
  });

  it('captures a failure envelope', async () => {
    const document = buildErrorDocument(
      'report',
      new PflError('example failure', EXIT_CODES.CONFIG_ERROR),
      ctx(),
    );
    await golden('failure', normalize(document));
  });
});

describe('read compatibility', () => {
  it('reads an older artifact shape that omits optional fields', async () => {
    const legacyHome = await mkdtemp(join(tmpdir(), 'pfl-golden-legacy-'));
    try {
      await mkdir(observationsDir('proj', legacyHome), { recursive: true });
      await writeFile(
        join(observationsDir('proj', legacyHome), 'obs_legacy000000000.json'),
        await readFile(join(FIXTURES, 'legacy-observed.json')),
      );

      const observed = await readObservedSnapshot('proj', 'obs_legacy000000000', legacyHome);

      expect(observed.runtime.id).toBe('claude-code');
      expect(observed.elements).toHaveLength(1);
      // The older shape wrote no `sizeBytes` on the source; the reader tolerates it.
      expect(observed.elements[0]?.source.sizeBytes).toBeUndefined();
    } finally {
      await rm(legacyHome, { recursive: true, force: true });
    }
  });

  it('reads the project index schema fixture', async () => {
    const indexHome = await mkdtemp(join(tmpdir(), 'pfl-golden-index-'));
    try {
      await mkdir(join(indexHome, '.pfl'), { recursive: true });
      await writeFile(
        projectIndexPath(indexHome),
        await readFile(join(FIXTURES, 'index.json')),
      );

      const index = await readProjectIndex(indexHome);

      expect(index).toEqual({
        indexVersion: '1',
        projects: { '/repo': 'path-0123456789abcdef' },
      });
    } finally {
      await rm(indexHome, { recursive: true, force: true });
    }
  });
});

describe('inspect golden', () => {
  it('captures the inspect document from a fixture harness', async () => {
    const m = await materialize('claude');
    try {
      const outcome = await runInspect(
        m.projectRoot,
        {
          runtime: 'claude-code',
          home: m.home,
          pathValue: '',
          interactive: false,
          allowScopes: ['claude-code:user', 'claude-code:install'],
        },
        silent,
      );
      const inspectProjectId = (await resolveProjectContext(m.projectRoot)).id;
      const value = normalize(buildDocument('inspect', outcome, { home: m.home }), [
        [m.home, 'FIXTURE_HOME'],
        [m.projectRoot, 'FIXTURE_ROOT'],
        [m.base, 'FIXTURE_BASE'],
        // The runtime encodes the project root with `/` as `-` in its own
        // layout, so the encoded base is replaced too.
        [m.base.replace(/\//g, '-'), 'FIXTURE_BASE_ENCODED'],
        [inspectProjectId, 'FIXTURE_PROJECT'],
      ]);
      await golden('inspect', value);
    } finally {
      await rm(m.base, { recursive: true, force: true });
    }
  });
});

describe('stored snapshot golden', () => {
  it('serializes each fixture back to the exact canonical bytes', async () => {
    for (const name of ['observed', 'resolved', 'interpretation']) {
      const text = await readFile(join(FIXTURES, `${name}.json`), 'utf8');
      // The fixture is the golden: canonical form is part of the contract
      // (ADR 0001), so the writer must reproduce the file byte for byte.
      expect(serializeSnapshot(JSON.parse(text) as never), name).toBe(text);
    }
  });
});
