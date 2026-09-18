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
import { runList } from '../../src/cli/list.js';
import { runReport } from '../../src/cli/report.js';
import { runShow } from '../../src/cli/show.js';
import { runSnapshots } from '../../src/cli/snapshots.js';
import { resolveProjectContext } from '../../src/discovery/project-identity.js';
import { serializeSnapshot } from '../../src/snapshot/serialization.js';
import {
  interpretationsDir,
  latestPath,
  observationsDir,
  readObservedSnapshot,
  snapshotsDir,
} from '../../src/snapshot/store.js';
import type { Logger } from '../../src/util/logger.js';

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

function normalize(envelope: Envelope): unknown {
  // Replace the values that legitimately vary between runs: the package version
  // and the temp project's id, root, and display name.
  let text = JSON.stringify(envelope);
  text = text.split(projectId).join('PROJECT_ID');
  text = text.split(projectRoot).join('PROJECT_ROOT');
  text = text.split(basename(projectRoot)).join('PROJECT_NAME');
  text = text.replace(/"pflVersion":"[^"]*"/, '"pflVersion":"VERSION"');
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
  it('reads a schema-1 artifact written by the previous version', async () => {
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
});

describe('stored snapshot golden', () => {
  it('round-trips the representative snapshot through canonical serialization', async () => {
    for (const name of ['observed', 'resolved', 'interpretation']) {
      const text = await readFile(join(FIXTURES, `${name}.json`), 'utf8');
      const parsed = JSON.parse(text) as never;
      // Canonical form is part of the contract (ADR 0001): serializing, parsing,
      // and serializing again is stable, independent of the file's own
      // formatting (the repo's formatter pretty-prints the fixture).
      const once = serializeSnapshot(parsed);
      expect(serializeSnapshot(JSON.parse(once) as never), name).toBe(once);
    }
  });
});
