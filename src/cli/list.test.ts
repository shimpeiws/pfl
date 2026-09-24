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
    scope?: string;
    inspectability?: ObservedElement['inspectability'];
  } = {},
): Pair {
  const origin = options.origin ?? (path.startsWith('~/') ? 'user' : 'project');
  const id = elementIdFor({ runtimeId: rid, origin, path, kind });
  return {
    observed: {
      id,
      native: { kind, origin, scope: options.scope ?? origin },
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
): Promise<{ observedSnapshotId: string }> {
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
  return { observedSnapshotId: observed.snapshotId };
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
  ids: { instructions: string; skills: string; permissions: string; memory: string };
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

    // Header names the runtime and snapshot so a consumer can assert which
    // run answered (#180); the four element rows follow it.
    expect(lines[0]).toContain('Runtime: claude-code');
    expect(lines).toHaveLength(6);
    // Skill row shows the derived label (parent dir), not the raw SKILL.md path.
    const skillLine = lines.find((l) => l.includes(ids.skills ?? '')) ?? '';
    expect(skillLine).toMatch(/^\.claude\/skills\/a\s+el_\w+\s+skills\s/);
  });

  it('filters by facet, origin, and status with AND', async () => {
    const { projectRoot, home, ids } = await fixture();

    const byFacet = fakeLogger();
    await runList(projectRoot, { home, facet: 'actions' }, byFacet.logger);
    expect(byFacet.lines.join('\n')).toContain(ids.skills ?? '');
    expect(byFacet.lines.join('\n')).not.toContain(ids.memory ?? '');

    const byStatus = fakeLogger();
    await runList(projectRoot, { home, status: 'shadowed' }, byStatus.logger);
    expect(byStatus.lines).toHaveLength(3);
    expect(byStatus.lines.at(-1)).toContain(ids.permissions ?? '');

    const byOrigin = fakeLogger();
    await runList(projectRoot, { home, origin: 'user' }, byOrigin.logger);
    expect(byOrigin.lines).toHaveLength(3);
    expect(byOrigin.lines.at(-1)).toContain(ids.memory ?? '');
  });

  it('filters by kind, and ORs repeated kinds', async () => {
    const { projectRoot, home, ids } = await fixture();

    const single = fakeLogger();
    await runList(projectRoot, { home, kind: ['skills'] }, single.logger);
    expect(single.lines).toHaveLength(3);
    expect(single.lines.at(-1)).toContain(ids.skills ?? '');

    const multiple = fakeLogger();
    await runList(projectRoot, { home, kind: ['skills', 'memory'] }, multiple.logger);
    expect(multiple.lines).toHaveLength(4);

    const none = fakeLogger();
    await runList(projectRoot, { home, kind: ['subagents', 'commands'] }, none.logger);
    expect(none.lines.at(-1)).toBe('No elements match.');
  });

  it('bounds output with --limit and keeps the matched total', async () => {
    const { projectRoot, home } = await fixture();
    const { lines, logger } = fakeLogger();

    const outcome = await runList(
      projectRoot,
      { home, kind: ['skills', 'memory'], limit: 1 },
      logger,
    );

    expect(outcome.data.count).toBe(1);
    expect(outcome.data.total).toBe(2);
    expect(outcome.data.elements).toHaveLength(1);
    // Runtime header, one row, then the truncation note.
    expect(lines).toHaveLength(4);
    expect(lines.at(-1)).toContain('1 more element(s) match');
  });

  it('limits JSON elements after the id sort, not before it', async () => {
    const projectRoot = await tempDir('pfl-list-project-');
    const home = await tempDir('pfl-list-home-');
    // Seed in descending id order so discovery order is the reverse of the
    // document order; a limit applied before sorting would keep the largest id.
    const pairs = [
      pair('instructions', 'CLAUDE.md'),
      pair('skills', '.claude/skills/a/SKILL.md'),
      pair('memory', '~/.claude/projects/x/memory/MEMORY.md'),
    ].sort((a, b) => (a.observed.id < b.observed.id ? 1 : -1));
    await seed(projectRoot, home, pairs);
    const smallest = pairs.at(-1)?.observed.id;

    const { lines, logger } = fakeLogger();
    const outcome = await runList(projectRoot, { home, json: true, limit: 1 }, logger);

    expect(outcome.data.elements.map((element) => element.id)).toEqual([smallest]);
    expect(outcome.data.total).toBe(3);

    // The human listing deliberately keeps discovery order; rows follow the
    // Runtime header.
    const human = fakeLogger();
    await runList(projectRoot, { home, limit: 1 }, human.logger);
    expect(human.lines[2]).toContain(pairs[0]?.observed.id ?? '');
    expect(lines).toHaveLength(0);
  });

  it('reports total equal to count when --limit is absent', async () => {
    const { projectRoot, home } = await fixture();
    const { logger } = fakeLogger();

    const outcome = await runList(projectRoot, { home, json: true }, logger);

    expect(outcome.data.count).toBe(4);
    expect(outcome.data.total).toBe(4);
  });

  it('fails on an invalid kind and lists valid values', async () => {
    const { projectRoot, home } = await fixture();
    const { logger } = fakeLogger();

    await expect(runList(projectRoot, { home, kind: ['hoks'] }, logger)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
      message: expect.stringContaining('hooks'),
    });
  });

  it('accepts an explicit snapshot id, observation or resolved', async () => {
    const projectRoot = await tempDir('pfl-list-project-');
    const home = await tempDir('pfl-list-home-');
    const instructions = pair('instructions', 'CLAUDE.md');
    const { observedSnapshotId } = await seed(projectRoot, home, [instructions]);

    const byResolved = fakeLogger();
    await runList(projectRoot, { home, snapshot: 'res_test' }, byResolved.logger);
    expect(byResolved.lines).toHaveLength(3);

    const byObserved = fakeLogger();
    await runList(projectRoot, { home, snapshot: observedSnapshotId }, byObserved.logger);
    expect(byObserved.lines).toHaveLength(3);
  });

  it('emits JSON with elements ordered by id', async () => {
    const { projectRoot, home } = await fixture();
    const { logger } = fakeLogger();

    const outcome = await runList(projectRoot, { home, json: true }, logger);

    expect(outcome.data.runtime).toBe('claude-code');
    expect(outcome.data.count).toBe(4);
    expect(outcome.data.elements[0]).toHaveProperty('facets');
    const ids = outcome.data.elements.map((element) => element.id);
    expect(ids).toEqual([...ids].sort());
    // path is present for elements with a source path.
    for (const element of outcome.data.elements) {
      expect(element).toHaveProperty('path');
      expect(typeof (element as { path?: string }).path).toBe('string');
    }
  });

  it('shows (none) for elements without a source path and omits path in JSON', async () => {
    const projectRoot = await tempDir('pfl-list-project-');
    const home = await tempDir('pfl-list-home-');
    const opaque = pair('runtime-provided-instructions', 'runtime://opaque', { origin: 'builtin' });
    // ObservedElement with no source.path.
    opaque.observed.source = {};
    await seed(projectRoot, home, [opaque]);

    const { lines, logger: humanLogger } = fakeLogger();
    await runList(projectRoot, { home }, humanLogger);
    expect(lines).toHaveLength(3);
    expect(lines.at(-1)).toMatch(/^\(none\)\s/);

    const { logger: jsonLogger } = fakeLogger();
    const outcome = await runList(projectRoot, { home, json: true }, jsonLogger);
    expect(outcome.data.elements[0]).not.toHaveProperty('path');
  });

  it('redacts the source path in JSON output', async () => {
    const projectRoot = await tempDir('pfl-list-project-');
    const home = await tempDir('pfl-list-home-');
    const absolutePath = join(home, '.claude', 'skills', 'x', 'SKILL.md');
    const el = pair('skills', absolutePath, { origin: 'user' });
    await seed(projectRoot, home, [el]);

    const { logger } = fakeLogger();
    const outcome = await runList(projectRoot, { home, json: true }, logger);
    const path = (outcome.data.elements[0] as { path?: string }).path;
    expect(path).toBeDefined();
    expect(path).toMatch(/^~\//);
    expect(path).not.toContain(home);
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

  it('marks compat-scope rows in the human listing (#165)', async () => {
    const projectRoot = await tempDir('pfl-list-project-');
    const home = await tempDir('pfl-list-home-');
    await seed(projectRoot, home, [
      pair('instructions', 'CLAUDE.md'),
      pair('skills', '~/.claude/skills/x/SKILL.md', { scope: 'claude-compat' }),
    ]);
    const { lines, logger } = fakeLogger();

    const outcome = await runList(projectRoot, { home }, logger);

    const output = lines.join('\n');
    expect(output).toContain('user (claude-compat)');
    // Plain consent scopes render bare — `user (user)` would be noise.
    expect(output).not.toContain('(user)');
    expect(outcome.data.elements.find((e) => e.scope === 'claude-compat')).toBeDefined();
  });
});
