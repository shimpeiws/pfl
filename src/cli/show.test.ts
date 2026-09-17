import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  elementIdFor,
  generateObservedSnapshotId,
  runtimeId,
  type ResolvedSnapshotId,
} from '../core/ids.js';
import type { NativeOrigin, ObservedElement, ObservedSnapshot } from '../core/observed.js';
import type { ResolvedElement, ResolvedSnapshot, ResolvedStatus } from '../core/resolved.js';
import { resolveProjectContext } from '../discovery/project-identity.js';
import {
  writeLatestPointer,
  writeObservedSnapshot,
  writeResolvedSnapshot,
} from '../snapshot/store.js';
import { EXIT_CODES } from './exit-codes.js';
import { runShow } from './show.js';

const rid = runtimeId('claude-code');
const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Pair {
  observed: ObservedElement;
  resolved: ResolvedElement;
}

function pair(
  kind: string,
  path: string,
  options: {
    origin?: NativeOrigin;
    status?: ResolvedStatus;
    inspectability?: ObservedElement['inspectability'];
  } = {},
): Pair {
  const origin = options.origin ?? (path.startsWith('~/') ? 'user' : 'project');
  const id = elementIdFor({ runtimeId: rid, origin, path, kind });
  return {
    observed: {
      id,
      native: { kind, origin, scope: origin },
      source: { path },
      inspectability: options.inspectability ?? 'observable',
      metadata: {},
      status: 'observed',
    },
    resolved: {
      id,
      status: options.status ?? 'effective',
      applicability: { type: 'project' },
      activation: 'always',
      resolution: { strategy: 'accumulate', reason: 'test' },
    },
  };
}

async function seed(
  projectRoot: string,
  home: string,
  pairs: Pair[],
  relations: ResolvedSnapshot['relations'] = [],
): Promise<void> {
  const projectId = (await resolveProjectContext(projectRoot)).id;
  const observed: ObservedSnapshot = {
    schemaVersion: '1',
    snapshotId: generateObservedSnapshotId(),
    capturedAt: '2026-09-16T00:00:00.000Z',
    project: { id: projectId, displayName: 'owner/repo', root: projectRoot },
    runtime: { id: rid, version: '2.1.272' },
    adapter: { id: 'claude-code', version: '0.1.0', runtimeCompatibility: 'verified' },
    elements: pairs.map((p) => p.observed),
    diagnostics: [],
    completeness: 'complete',
    digests: { observed: 'sha256:x' },
  };
  const resolved: ResolvedSnapshot = {
    schemaVersion: '1',
    snapshotId: 'res_test' as ResolvedSnapshotId,
    observedSnapshotId: observed.snapshotId,
    runtime: { id: rid, version: '2.1.272' },
    resolution: { semanticsVersion: '1', confidence: 'verified' },
    elements: pairs.map((p) => p.resolved),
    relations: [...relations],
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
}

function fakeLogger() {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (message: string, data?: Record<string, unknown>) => {
        lines.push(data === undefined ? message : JSON.stringify({ message, ...data }));
      },
      warn: () => undefined,
      error: () => undefined,
    },
  };
}

describe('runShow', () => {
  it('shows provenance, resolution reason, relations, and citing findings', async () => {
    const projectRoot = await tempDir('pfl-show-project-');
    const home = await tempDir('pfl-show-home-');
    const winner = pair('permissions', '.claude/settings.json#permissions');
    const loser = pair('permissions', '~/.claude/settings.json#permissions', {
      origin: 'user',
      status: 'shadowed',
    });
    await seed(
      projectRoot,
      home,
      [winner, loser],
      [{ type: 'shadows', from: winner.observed.id, to: loser.observed.id }],
    );
    const { lines, logger } = fakeLogger();

    await runShow(projectRoot, loser.observed.id, { home }, logger);

    const output = lines.join('\n');
    expect(output).toContain(`Element ${loser.observed.id}`);
    expect(output).toContain('status          shadowed');
    expect(output).toContain('resolution      accumulate — test');
    expect(output).toContain(`shadows: ${winner.observed.id} -> ${loser.observed.id}`);
    expect(output).toContain('shadowed by a higher-precedence layer');
  });

  it('shows an opaque element as opaque without summarizing it', async () => {
    const projectRoot = await tempDir('pfl-show-project-');
    const home = await tempDir('pfl-show-home-');
    const opaque = pair('runtime-provided-instructions', '(builtin) layers', {
      origin: 'builtin',
      inspectability: 'opaque',
    });
    await seed(projectRoot, home, [opaque]);
    const { lines, logger } = fakeLogger();

    await runShow(projectRoot, opaque.observed.id, { home }, logger);

    expect(lines.join('\n')).toContain('inspectability  opaque');
  });

  it('fails clearly on an unknown element id', async () => {
    const projectRoot = await tempDir('pfl-show-project-');
    const home = await tempDir('pfl-show-home-');
    await seed(projectRoot, home, [pair('instructions', 'CLAUDE.md')]);
    const { logger } = fakeLogger();

    await expect(runShow(projectRoot, 'el_missing', { home }, logger)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
    });
  });

  it('emits JSON', async () => {
    const projectRoot = await tempDir('pfl-show-project-');
    const home = await tempDir('pfl-show-home-');
    const instructions = pair('instructions', 'CLAUDE.md');
    await seed(projectRoot, home, [instructions]);
    const { logger } = fakeLogger();

    const outcome = await runShow(
      projectRoot,
      instructions.observed.id,
      { home, json: true },
      logger,
    );

    expect(outcome.data.observed.native.kind).toBe('instructions');
    expect(outcome.data.resolved?.status).toBe('effective');
  });
});
