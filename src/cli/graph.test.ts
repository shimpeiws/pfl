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
import { runGraph } from './graph.js';

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
  relations: ResolvedSnapshot['relations'],
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

async function fixture() {
  const projectRoot = await tempDir('pfl-graph-project-');
  const home = await tempDir('pfl-graph-home-');
  const projectInstructions = pair('instructions', 'CLAUDE.md');
  const userInstructions = pair('instructions', '~/.claude/CLAUDE.md');
  const projectPermissions = pair('permissions', '.claude/settings.json#permissions');
  const userPermissions = pair('permissions', '~/.claude/settings.json#permissions', {
    origin: 'user',
    status: 'shadowed',
  });
  const opaque = pair('runtime-provided-instructions', '(builtin) layers', {
    origin: 'builtin',
    inspectability: 'opaque',
  });
  await seed(
    projectRoot,
    home,
    [projectInstructions, userInstructions, projectPermissions, userPermissions, opaque],
    [
      {
        type: 'accumulates-with',
        from: projectInstructions.observed.id,
        to: userInstructions.observed.id,
      },
      { type: 'shadows', from: projectPermissions.observed.id, to: userPermissions.observed.id },
    ],
  );
  return { projectRoot, home };
}

describe('runGraph', () => {
  it('renders sources by origin, edges, and effective by facet', async () => {
    const { projectRoot, home } = await fixture();
    const { lines, logger } = fakeLogger();

    await runGraph(projectRoot, { home }, logger);

    const output = lines.join('\n');
    expect(output).toContain('user');
    expect(output).toContain('project');
    expect(output).toContain('accumulates → ~/.claude/CLAUDE.md');
    expect(output).toContain('shadows → ~/.claude/settings.json#permissions');
    expect(output).toContain('(opaque)');
    expect(output).toContain('effective');
    expect(output).toContain('instructions');
  });

  it('emits nodes and edges as JSON', async () => {
    const { projectRoot, home } = await fixture();
    const { lines, logger } = fakeLogger();

    await runGraph(projectRoot, { home, json: true }, logger);

    const payload = JSON.parse(lines[0] ?? '{}');
    expect(payload.resolvedSnapshotId).toBe('res_test');
    expect(payload.nodes).toHaveLength(5);
    expect(payload.edges.map((edge: { type: string }) => edge.type)).toContain('accumulates-with');
    expect(payload.edges.map((edge: { type: string }) => edge.type)).toContain('shadows');
  });
});
