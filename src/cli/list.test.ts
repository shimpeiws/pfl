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
import { runList } from './list.js';

export const rid = runtimeId('claude-code');

export interface Pair {
  observed: ObservedElement;
  resolved: ResolvedElement;
}

export function pair(
  kind: string,
  path: string,
  options: {
    origin?: NativeOrigin;
    status?: ResolvedStatus;
    inspectability?: ObservedElement['inspectability'];
  } = {},
): Pair {
  const origin = options.origin ?? (path.startsWith('~/') ? 'user' : 'project');
  const id = elementIdFor({ runtimeId: rid, origin, path });
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

export async function seed(
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

const tempDirs: string[] = [];

export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

async function fixture(): Promise<{
  projectRoot: string;
  home: string;
  ids: Record<string, string>;
}> {
  const projectRoot = await tempDir('pfl-list-project-');
  const home = await tempDir('pfl-list-home-');
  const instructions = pair('instructions', 'CLAUDE.md');
  const skills = pair('skills', '.claude/skills/a/SKILL.md');
  const permissions = pair('permissions', '.claude/settings.json#permissions', {
    status: 'shadowed',
  });
  const memory = pair('memory', '~/.claude/projects/x/memory/MEMORY.md');
  await seed(projectRoot, home, [instructions, skills, permissions, memory]);
  return {
    projectRoot,
    home,
    ids: {
      instructions: instructions.observed.id,
      skills: skills.observed.id,
      permissions: permissions.observed.id,
      memory: memory.observed.id,
    },
  };
}

describe('runList', () => {
  it('lists every element without filters', async () => {
    const { projectRoot, home, ids } = await fixture();
    const { lines, logger } = fakeLogger();

    await runList(projectRoot, { home }, logger);

    expect(lines).toHaveLength(4);
    expect(lines.join('\n')).toContain(ids.skills ?? '');
    expect(lines.join('\n')).toContain('skills');
  });

  it('filters by facet, origin, and status with AND', async () => {
    const { projectRoot, home, ids } = await fixture();

    const byFacet = fakeLogger();
    await runList(projectRoot, { home, facet: 'actions' }, byFacet.logger);
    expect(byFacet.lines.join('\n')).toContain(ids.skills ?? '');
    expect(byFacet.lines.join('\n')).not.toContain(ids.memory ?? '');

    const byStatus = fakeLogger();
    await runList(projectRoot, { home, status: 'shadowed' }, byStatus.logger);
    expect(byStatus.lines).toHaveLength(1);
    expect(byStatus.lines[0]).toContain(ids.permissions ?? '');

    const byOrigin = fakeLogger();
    await runList(projectRoot, { home, origin: 'user' }, byOrigin.logger);
    expect(byOrigin.lines).toHaveLength(1);
    expect(byOrigin.lines[0]).toContain(ids.memory ?? '');
  });

  it('emits JSON', async () => {
    const { projectRoot, home } = await fixture();
    const { lines, logger } = fakeLogger();

    await runList(projectRoot, { home, json: true }, logger);

    const payload = JSON.parse(lines[0] ?? '{}');
    expect(payload.count).toBe(4);
    expect(payload.elements[0]).toHaveProperty('facets');
  });

  it('fails on an invalid facet and lists valid values', async () => {
    const { projectRoot, home } = await fixture();
    const { logger } = fakeLogger();

    await expect(runList(projectRoot, { home, facet: 'telepathy' }, logger)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
      message: expect.stringContaining('instructions'),
    });
  });

  it('fails on an invalid origin and status', async () => {
    const { projectRoot, home } = await fixture();
    const { logger } = fakeLogger();

    await expect(runList(projectRoot, { home, origin: 'elsewhere' }, logger)).rejects.toMatchObject(
      {
        exitCode: EXIT_CODES.CONFIG_ERROR,
      },
    );
    await expect(runList(projectRoot, { home, status: 'zombie' }, logger)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
    });
  });
});
