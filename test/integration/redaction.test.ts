import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDiff } from '../../src/cli/diff.js';
import { buildDocument, type CommandOutcome } from '../../src/cli/document.js';
import { runGraph } from '../../src/cli/graph.js';
import { runInspect } from '../../src/cli/inspect.js';
import { runList } from '../../src/cli/list.js';
import { runReport } from '../../src/cli/report.js';
import { runShow } from '../../src/cli/show.js';
import { runSnapshots } from '../../src/cli/snapshots.js';
import {
  elementIdFor,
  generateObservedSnapshotId,
  generateResolvedSnapshotId,
  runtimeId,
} from '../../src/core/ids.js';
import type { ObservedSnapshot } from '../../src/core/observed.js';
import type { ResolvedSnapshot } from '../../src/core/resolved.js';
import { resolveProjectContext } from '../../src/discovery/project-identity.js';
import { encodeProjectDir } from '../../src/runtime/claude-code/paths.js';
import { realpathAsFarAsExists } from '../../src/util/fs.js';
import {
  observationsDir,
  readLatestPointer,
  readObservedSnapshot,
  readResolvedSnapshot,
  writeLatestPointer,
  writeObservedSnapshot,
  writeResolvedSnapshot,
} from '../../src/snapshot/store.js';
import type { Logger } from '../../src/util/logger.js';
import { grantConsent } from '../fixtures/materialize.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Output {
  logger: Logger;
  text(): string;
}

/** A logger that keeps every message and structured payload it is given. */
function captureLogger(): Output {
  const parts: string[] = [];
  const record = (level: string, message: string, data?: Record<string, unknown>) =>
    parts.push(
      data === undefined ? `${level}:${message}` : `${level}:${message}:${JSON.stringify(data)}`,
    );
  return {
    logger: {
      info: (message, data) => record('info', message, data),
      warn: (message, data) => record('warn', message, data),
      error: (message, data) => record('error', message, data),
    },
    text: () => parts.join('\n'),
  };
}

interface Fixture {
  home: string;
  projectRoot: string;
}

/**
 * A harness whose project root lives *under* the home directory, so the home
 * prefix appears in the persisted project root and, `/`→`-` encoded, inside the
 * memory path. That is what the redaction has to remove.
 */
async function makeFixture(): Promise<Fixture> {
  const rawBase = await mkdtemp(join(tmpdir(), 'pfl-redact-'));
  tempDirs.push(rawBase);
  // Canonicalise first: project identity realpaths the root, so the home used
  // for redaction must be canonical too or the prefixes will not match.
  const base = await realpathAsFarAsExists(rawBase);
  const home = join(base, 'home');
  const projectRoot = join(home, 'project');
  const configDir = join(home, '.claude');
  const memory = join(configDir, 'projects', encodeProjectDir(projectRoot), 'memory');

  await mkdir(join(configDir, 'skills', 'foo'), { recursive: true });
  await mkdir(memory, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, 'CLAUDE.md'), '# Project instructions\n');
  await writeFile(join(configDir, 'CLAUDE.md'), '# User instructions\n');
  await writeFile(join(configDir, 'skills', 'foo', 'SKILL.md'), '# Foo skill\n');
  await writeFile(join(memory, 'MEMORY.md'), '# Memory\n');
  await writeFile(
    join(configDir, 'settings.json'),
    JSON.stringify({ permissions: { allow: [], deny: [], ask: [] }, token: 'sk-ant-secret-value' }),
  );
  return { home, projectRoot };
}

async function inspectAndLoad(fixture: Fixture) {
  await grantConsent(fixture.home, 'claude');
  await runInspect(
    fixture.projectRoot,
    { runtime: 'claude-code', home: fixture.home, pathValue: '', interactive: false },
    { info: () => undefined, warn: () => undefined, error: () => undefined },
  );
  const projectId = (await resolveProjectContext(fixture.projectRoot)).id;
  const pointer = await readLatestPointer(projectId, fixture.home);
  if (pointer === null) throw new Error('expected a latest pointer');
  return {
    projectId,
    observed: await readObservedSnapshot(projectId, pointer.observed, fixture.home),
    resolved: await readResolvedSnapshot(projectId, pointer.resolved, fixture.home),
  };
}

/** Every string value in a JSON structure, so a property can be checked over all of them. */
function everyString(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(everyString);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap(everyString);
  }
  return [];
}

describe('redaction across every channel (S6, S8)', () => {
  it('persists no home path, no secret, and keeps structural fields intact', async () => {
    const fixture = await makeFixture();
    const { observed, resolved } = await inspectAndLoad(fixture);

    // Property: no string anywhere in the persisted snapshots contains the home directory.
    for (const text of everyString(observed)) {
      expect(text).not.toContain(fixture.home);
    }
    for (const text of everyString(resolved)) {
      expect(text).not.toContain(fixture.home);
    }

    // The stated treatment for project.root: the home prefix becomes `~`.
    expect(observed.project.root).toBe('~/project');
    // The `/`→`-` encoded root inside the memory path is stripped too.
    const memory = observed.elements.find((element) =>
      (element.source.path ?? '').endsWith('memory/MEMORY.md'),
    );
    expect(memory?.source.path ?? '').toContain('~');
    expect(memory?.source.path ?? '').not.toContain(fixture.home);

    // Structural fields are not blanket-redacted.
    expect(observed.snapshotId).toMatch(/^obs_/);
    expect(resolved.snapshotId).toMatch(/^res_/);
    const digested = observed.elements.find((element) => element.source.digest !== undefined);
    expect(digested?.source.digest).toMatch(/^sha256:/);
    expect(JSON.stringify(observed)).not.toContain('sk-ant-secret-value');
  });

  it('prints no home path and no secret on any command', async () => {
    const fixture = await makeFixture();
    const { observed, resolved } = await inspectAndLoad(fixture);
    const elementWithDigest = observed.elements.find(
      (element) => element.source.digest !== undefined,
    );
    const elementId = elementWithDigest?.id ?? observed.elements[0]?.id ?? '';

    for (const json of [false, true]) {
      const out = captureLogger();
      // Under `--json` the payload leaves through the document envelope, not the
      // logger, so the envelope is built here exactly as the CLI wrapper does.
      const documents: unknown[] = [];
      const collect = <T>(command: string, outcome: CommandOutcome<T>): void => {
        if (json) documents.push(buildDocument(command, outcome, { home: fixture.home }));
      };
      collect(
        'inspect',
        await runInspect(
          fixture.projectRoot,
          { runtime: 'claude-code', home: fixture.home, pathValue: '', interactive: false, json },
          out.logger,
        ),
      );
      collect(
        'report',
        await runReport(fixture.projectRoot, { home: fixture.home, json }, out.logger),
      );
      collect('list', await runList(fixture.projectRoot, { home: fixture.home, json }, out.logger));
      collect(
        'graph',
        await runGraph(fixture.projectRoot, { home: fixture.home, json }, out.logger),
      );
      collect(
        'snapshots',
        await runSnapshots(fixture.projectRoot, { home: fixture.home, json }, out.logger),
      );
      collect(
        'show',
        await runShow(fixture.projectRoot, elementId, { home: fixture.home, json }, out.logger),
      );
      collect(
        'diff',
        await runDiff(
          fixture.projectRoot,
          resolved.snapshotId,
          resolved.snapshotId,
          { home: fixture.home, json },
          out.logger,
        ),
      );

      const text = [out.text(), ...documents.map((document) => JSON.stringify(document))].join(
        '\n',
      );
      expect(text).not.toContain(fixture.home);
      expect(text).not.toContain('sk-ant-secret-value');
      // The digest still reaches the output, so redaction is not blanket.
      expect(text).toContain('sha256:');
    }
  });

  it('redacts a read-time store diagnostic before it is printed', async () => {
    const fixture = await makeFixture();
    const { projectId } = await inspectAndLoad(fixture);
    // Point the observations directory at a symlink so listRuns emits a
    // diagnostic whose path is under the home directory. This is text produced
    // at read time, never persisted, so only the logger wrapper can redact it.
    const outside = join(fixture.home, 'outside-observations');
    await mkdir(outside, { recursive: true });
    await rm(observationsDir(projectId, fixture.home), { recursive: true, force: true });
    await symlink(outside, observationsDir(projectId, fixture.home));

    const out = captureLogger();
    await runSnapshots(fixture.projectRoot, { home: fixture.home }, out.logger);

    expect(out.text()).not.toContain(fixture.home);
    expect(out.text()).toContain('~');
  });

  it('re-redacts an artifact path at the document boundary, even if stored raw', async () => {
    const fixture = await makeFixture();
    const projectId = (await resolveProjectContext(fixture.projectRoot)).id;
    const rid = runtimeId('claude-code');
    // A snapshot stored before redaction existed, or tampered with, holds a raw
    // absolute path. The document layer must not trust it.
    const rawPath = join(fixture.home, 'leaked', 'CLAUDE.md');
    const id = elementIdFor({
      runtimeId: rid,
      origin: 'project',
      kind: 'instructions',
      path: rawPath,
    });
    const observed: ObservedSnapshot = {
      schemaVersion: '1',
      snapshotId: generateObservedSnapshotId(),
      capturedAt: '2026-09-16T00:00:00.000Z',
      project: { id: projectId, displayName: 'proj', root: fixture.projectRoot },
      runtime: { id: rid, version: '2.1.272' },
      adapter: { id: 'claude-code', version: '0.1.0', runtimeCompatibility: 'verified' },
      elements: [
        {
          id,
          native: { kind: 'instructions', origin: 'project', scope: 'project' },
          source: { path: rawPath },
          inspectability: 'observable',
          metadata: {},
          status: 'observed',
        },
      ],
      diagnostics: [],
      completeness: 'complete',
      digests: { observed: 'sha256:x' },
    };
    const resolved: ResolvedSnapshot = {
      schemaVersion: '1',
      snapshotId: generateResolvedSnapshotId(),
      observedSnapshotId: observed.snapshotId,
      runtime: { id: rid, version: '2.1.272' },
      resolution: { semanticsVersion: '1', confidence: 'verified' },
      elements: [
        {
          id,
          status: 'effective',
          applicability: { type: 'project' },
          activation: 'always',
          resolution: { strategy: 'accumulate' },
        },
      ],
      relations: [],
      effectiveElementIds: [id],
      diagnostics: [],
      digests: { harnessContent: 'sha256:h', resolvedSnapshot: 'sha256:r' },
    };
    await writeObservedSnapshot(projectId, observed, fixture.home);
    await writeResolvedSnapshot(projectId, resolved, fixture.home);
    await writeLatestPointer(
      projectId,
      { observed: observed.snapshotId, resolved: resolved.snapshotId },
      fixture.home,
    );

    const showOutcome = await runShow(
      fixture.projectRoot,
      id,
      { home: fixture.home, json: true },
      captureLogger().logger,
    );
    const graphOutcome = await runGraph(
      fixture.projectRoot,
      { home: fixture.home, json: true },
      captureLogger().logger,
    );

    const showDocument = JSON.stringify(buildDocument('show', showOutcome, { home: fixture.home }));
    const graphDocument = JSON.stringify(
      buildDocument('graph', graphOutcome, { home: fixture.home }),
    );
    expect(showDocument).not.toContain(fixture.home);
    expect(showDocument).toContain('~');
    expect(graphDocument).not.toContain(fixture.home);
    expect(graphDocument).toContain('~');
  });
});
