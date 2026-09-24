import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  elementIdFor,
  generateObservedSnapshotId,
  runtimeId,
  type ResolvedSnapshotId,
  type RuntimeId,
} from '../core/ids.js';
import type { NativeOrigin, ObservedElement, ObservedSnapshot } from '../core/observed.js';
import type { ResolvedElement, ResolvedSnapshot, ResolvedStatus } from '../core/resolved.js';
import { resolveProjectContext } from '../discovery/project-identity.js';
import {
  artifactFilePath,
  snapshotsDir,
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
    omitPath?: boolean;
    runtime?: RuntimeId;
  } = {},
): Pair {
  const origin = options.origin ?? (path.startsWith('~/') ? 'user' : 'project');
  const id = elementIdFor({ runtimeId: options.runtime ?? rid, origin, path, kind });
  return {
    observed: {
      id,
      native: { kind, origin, scope: origin },
      source: options.omitPath === true ? {} : { path },
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

async function seedRun(
  projectRoot: string,
  home: string,
  pairs: Pair[],
  options: {
    capturedAt?: string;
    resolvedId?: string;
    relations?: ResolvedSnapshot['relations'];
    latest?: boolean;
    runtime?: RuntimeId;
  } = {},
): Promise<{ observedId: string; resolvedId: string }> {
  const projectId = (await resolveProjectContext(projectRoot)).id;
  const runtime = options.runtime ?? rid;
  const observed: ObservedSnapshot = {
    schemaVersion: '1',
    snapshotId: generateObservedSnapshotId(),
    capturedAt: options.capturedAt ?? '2026-09-16T00:00:00.000Z',
    project: { id: projectId, displayName: 'owner/repo', root: projectRoot },
    runtime: { id: runtime, version: '2.1.272' },
    adapter: { id: runtime, version: '0.1.0', runtimeCompatibility: 'verified' },
    elements: pairs.map((p) => p.observed),
    diagnostics: [],
    completeness: 'complete',
    digests: { observed: 'sha256:x' },
  };
  const resolved: ResolvedSnapshot = {
    schemaVersion: '1',
    snapshotId: (options.resolvedId ?? 'res_test') as ResolvedSnapshotId,
    observedSnapshotId: observed.snapshotId,
    runtime: { id: runtime, version: '2.1.272' },
    resolution: { semanticsVersion: '1', confidence: 'verified' },
    elements: pairs.map((p) => p.resolved),
    relations: [...(options.relations ?? [])],
    effectiveElementIds: [],
    diagnostics: [],
    digests: { harnessContent: 'sha256:h', resolvedSnapshot: 'sha256:r' },
  };
  await writeObservedSnapshot(projectId, observed, home);
  await writeResolvedSnapshot(projectId, resolved, home);
  if (options.latest !== false) {
    await writeLatestPointer(
      projectId,
      { observed: observed.snapshotId, resolved: resolved.snapshotId },
      home,
    );
  }
  return { observedId: observed.snapshotId, resolvedId: resolved.snapshotId };
}

async function seed(
  projectRoot: string,
  home: string,
  pairs: Pair[],
  relations: ResolvedSnapshot['relations'] = [],
): Promise<void> {
  await seedRun(projectRoot, home, pairs, { relations });
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
    expect(output).toContain(
      'shadows: .claude/settings.json#permissions -> ~/.claude/settings.json#permissions',
    );
    expect(output).toContain('shadowed by a higher-precedence layer');
  });

  it('falls back to the element id for a relation endpoint without a path', async () => {
    const projectRoot = await tempDir('pfl-show-project-');
    const home = await tempDir('pfl-show-home-');
    const opaque = pair('runtime-provided-instructions', '(builtin) layers', {
      origin: 'builtin',
      inspectability: 'opaque',
      omitPath: true,
    });
    const instructions = pair('instructions', 'CLAUDE.md');
    await seed(
      projectRoot,
      home,
      [opaque, instructions],
      [{ type: 'accumulates-with', from: instructions.observed.id, to: opaque.observed.id }],
    );
    const { lines, logger } = fakeLogger();

    await runShow(projectRoot, instructions.observed.id, { home }, logger);

    expect(lines.join('\n')).toContain(`accumulates-with: CLAUDE.md -> ${opaque.observed.id}`);
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

  it('rejects a malformed id as not an element id (#168)', async () => {
    const projectRoot = await tempDir('pfl-show-project-');
    const home = await tempDir('pfl-show-home-');
    await seed(projectRoot, home, [pair('instructions', 'CLAUDE.md')]);
    const { logger } = fakeLogger();

    await expect(runShow(projectRoot, 'el_missing', { home }, logger)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
      message: expect.stringContaining('not an element id'),
    });
  });

  it('names the stored run that owns a well-formed unknown id (#168)', async () => {
    const projectRoot = await tempDir('pfl-show-project-');
    const home = await tempDir('pfl-show-home-');
    const older = await seedRun(
      projectRoot,
      home,
      [pair('skills', '~/.claude/skills/difit/SKILL.md')],
      {
        capturedAt: '2026-09-15T00:00:00.000Z',
        resolvedId: 'res_older',
        latest: false,
      },
    );
    const target = pair('skills', '~/.claude/skills/difit/SKILL.md').observed.id;
    await seedRun(projectRoot, home, [pair('instructions', 'CLAUDE.md')], {
      capturedAt: '2026-09-16T00:00:00.000Z',
    });
    const { logger } = fakeLogger();

    await expect(runShow(projectRoot, target, { home }, logger)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
      message: expect.stringContaining(
        `is in ${older.observedId} (claude-code, 2026-09-15), not the selected snapshot; re-run with --snapshot ${older.observedId}`,
      ),
    });
  });

  it('does not suggest --snapshot for a run with no readable resolved snapshot (#168)', async () => {
    const projectRoot = await tempDir('pfl-show-project-');
    const home = await tempDir('pfl-show-home-');
    const target = pair('skills', '~/.claude/skills/difit/SKILL.md');
    const older = await seedRun(projectRoot, home, [target], {
      capturedAt: '2026-09-15T00:00:00.000Z',
      resolvedId: 'res_older',
      latest: false,
    });
    // Simulate an interrupted inspection: the observation is stored but its
    // resolved snapshot cannot be read.
    const projectId = (await resolveProjectContext(projectRoot)).id;
    await rm(artifactFilePath(snapshotsDir(projectId, home), older.resolvedId));
    await seedRun(projectRoot, home, [pair('instructions', 'CLAUDE.md')], {
      capturedAt: '2026-09-16T00:00:00.000Z',
    });
    const { logger } = fakeLogger();

    await expect(runShow(projectRoot, target.observed.id, { home }, logger)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
      message: expect.stringContaining(
        `is in ${older.observedId} (claude-code, 2026-09-15), but that run has no readable resolved snapshot`,
      ),
    });
  });

  it('carries --runtime in the hint when a scope would reject the owning run (#168)', async () => {
    const projectRoot = await tempDir('pfl-show-project-');
    const home = await tempDir('pfl-show-home-');
    const opencode = runtimeId('opencode');
    const owner = pair('skills', '~/.config/opencode/skills/difit/SKILL.md', {
      runtime: opencode,
    });
    const older = await seedRun(projectRoot, home, [owner], {
      capturedAt: '2026-09-15T00:00:00.000Z',
      resolvedId: 'res_older',
      latest: false,
      runtime: opencode,
    });
    await seedRun(projectRoot, home, [pair('instructions', 'CLAUDE.md')], {
      capturedAt: '2026-09-16T00:00:00.000Z',
    });
    const { logger } = fakeLogger();

    await expect(
      runShow(projectRoot, owner.observed.id, { home, runtime: 'claude-code' }, logger),
    ).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
      message: expect.stringContaining(`--snapshot ${older.observedId} --runtime opencode`),
    });
  });

  it('points at list and snapshots when the id is in no stored run (#168)', async () => {
    const projectRoot = await tempDir('pfl-show-project-');
    const home = await tempDir('pfl-show-home-');
    await seed(projectRoot, home, [pair('instructions', 'CLAUDE.md')]);
    const { logger } = fakeLogger();

    await expect(
      runShow(projectRoot, 'el_0000000000000000', { home }, logger),
    ).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
      message: expect.stringContaining('`pfl snapshots`'),
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
