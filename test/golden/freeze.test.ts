import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classify } from '../../src/classify/classifier.js';
import { deriveFindings } from '../../src/classify/findings.js';
import { buildDocument, buildErrorDocument, type Envelope } from '../../src/cli/document.js';
import { elementIdFor, runtimeId } from '../../src/core/ids.js';
import type { ObservedElement } from '../../src/core/observed.js';
import type { ResolvedElement } from '../../src/core/resolved.js';
import { assembleObservedSnapshot } from '../../src/discovery/assemble.js';
import { assembleResolvedSnapshot } from '../../src/resolution/assemble.js';
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
const RUNTIME = runtimeId('claude-code');
const ELEMENT_ID = elementIdFor({
  runtimeId: RUNTIME,
  origin: 'project',
  path: 'CLAUDE.md',
  kind: 'instructions',
});
const OBSERVED_ID = 'obs_0123456789ab';
const RESOLVED_ID = 'res_0123456789ab';

/** The representative observed snapshot, built through the real assembler. */
function buildObserved() {
  const element: ObservedElement = {
    id: ELEMENT_ID,
    native: { kind: 'instructions', origin: 'project', scope: 'project' },
    source: {
      path: 'CLAUDE.md',
      digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      sizeBytes: 12,
    },
    inspectability: 'observable',
    metadata: {},
    status: 'observed',
  };
  return assembleObservedSnapshot({
    project: { id: 'path-0123456789abcdef', displayName: 'owner/repo', root: '/repo' },
    runtime: { id: RUNTIME, version: '2.1.272' },
    adapter: { id: 'claude-code', version: '0.1.1', runtimeCompatibility: 'verified' },
    elements: [element],
    diagnostics: [{ severity: 'warning', code: 'example', message: 'example' }],
    capturedAt: '2026-09-18T00:00:00.000Z',
    snapshotId: OBSERVED_ID as never,
    home: '',
  });
}

function buildResolved() {
  const observed = buildObserved();
  const element: ResolvedElement = {
    id: ELEMENT_ID,
    status: 'effective',
    applicability: { type: 'project' },
    activation: 'always',
    resolution: { strategy: 'accumulate' },
  };
  return assembleResolvedSnapshot({
    observed,
    elements: [element],
    snapshotId: RESOLVED_ID as never,
    runtimeCompatibility: 'verified',
  });
}

function buildInterpretation() {
  const observed = buildObserved();
  const resolved = buildResolved();
  return {
    schemaVersion: '1',
    interpretationId: 'int_0123456789ab',
    resolvedSnapshotId: resolved.snapshotId,
    ...classify(observed, resolved),
    findings: deriveFindings(observed, resolved),
  };
}

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

function normalize(
  envelope: Envelope,
  extra: ReadonlyArray<readonly [string, string]> = [],
  maskIds = false,
): unknown {
  // Replace the values that legitimately vary between runs: the package version
  // and the temp project's id, root, and display name. Snapshot ids are masked
  // only where a command generates them freshly (`inspect`); everywhere else the
  // fixture ids are fixed, and masking them would hide an id-wiring regression.
  let text = JSON.stringify(envelope);
  for (const [from, to] of [
    [projectId, 'PROJECT_ID'],
    [projectRoot, 'PROJECT_ROOT'],
    [basename(projectRoot), 'PROJECT_NAME'],
    ...extra,
  ] as ReadonlyArray<readonly [string, string]>) {
    if (from !== '') text = text.split(from).join(to);
  }
  text = text.replace(/"pflVersion":"[^"]*"/g, '"pflVersion":"VERSION"');
  if (maskIds) {
    text = text
      .replace(/obs_[0-9a-f]{12}/g, 'obs_ID')
      .replace(/res_[0-9a-f]{12}/g, 'res_ID')
      .replace(/int_[0-9a-f]{12}/g, 'int_ID');
  }
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
      // The runtime encodes the canonical project root with `/` as `-` in its
      // own memory path. The canonical (realpath) form must be replaced, not the
      // raw temp path: on macOS `mkdtemp` returns `/var/...` while realpath is
      // `/private/var/...`, and Linux has no such alias.
      const canonicalRoot = await realpath(m.projectRoot);
      const canonicalBase = await realpath(m.base);
      const value = normalize(
        buildDocument('inspect', outcome, { home: m.home }),
        [
          [canonicalRoot.replace(/\//g, '-'), 'FIXTURE_ENCODED_ROOT'],
          [canonicalRoot, 'FIXTURE_CANON_ROOT'],
          [canonicalBase, 'FIXTURE_CANON_BASE'],
          [m.projectRoot, 'FIXTURE_ROOT'],
          [m.base, 'FIXTURE_BASE'],
          [m.home, 'FIXTURE_HOME'],
          [inspectProjectId, 'FIXTURE_PROJECT'],
        ],
        true,
      );
      await golden('inspect', value);
    } finally {
      await rm(m.base, { recursive: true, force: true });
    }
  });
});

describe('stored snapshot golden', () => {
  it('pins the assembler output to the fixture byte for byte', async () => {
    const built: Record<string, string> = {
      observed: serializeSnapshot(buildObserved()),
      resolved: serializeSnapshot(buildResolved()),
      interpretation: serializeSnapshot(buildInterpretation() as never),
    };
    for (const [name, bytes] of Object.entries(built)) {
      const fixture = await readFile(join(FIXTURES, `${name}.json`), 'utf8');
      // The fixture is the assembler's canonical output: a new field or a
      // changed shape in assembly moves the bytes and fails here, which the
      // serializer round-trip alone would not catch.
      expect(bytes, name).toBe(fixture);
      expect(serializeSnapshot(JSON.parse(fixture) as never), name).toBe(fixture);
    }
  });
});
