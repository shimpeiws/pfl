import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_CODES } from './exit-codes.js';
import {
  elementIdFor,
  generateObservedSnapshotId,
  runtimeId,
  type ResolvedSnapshotId,
} from '../core/ids.js';
import type { ObservedElement, ObservedSnapshot } from '../core/observed.js';
import type { ResolvedElement, ResolvedSnapshot, ResolvedStatus } from '../core/resolved.js';
import { resolveProjectContext } from '../discovery/project-identity.js';
import {
  snapshotsDir,
  writeLatestPointer,
  writeObservedSnapshot,
  writeResolvedSnapshot,
} from '../snapshot/store.js';
import { runReport } from './report.js';

const tempDirs: string[] = [];
const rid = runtimeId('claude-code');

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function fakeLogger() {
  const lines: string[] = [];
  const warns: string[] = [];
  const record = (target: string[], level: string, message: string, data?: unknown) => {
    target.push(
      data === undefined ? message : JSON.stringify({ level, message, ...(data as object) }),
    );
  };
  return {
    lines,
    warns,
    logger: {
      info: (message: string, data?: Record<string, unknown>) => {
        record(lines, 'info', message, data);
      },
      warn: (message: string, data?: Record<string, unknown>) => {
        record(warns, 'warn', message, data);
      },
      error: () => undefined,
    },
  };
}

interface Pair {
  observed: ObservedElement;
  resolved: ResolvedElement;
}

function pair(
  kind: string,
  path: string,
  resolvedStatus: ResolvedStatus = 'effective',
  observed: { status?: ObservedElement['status']; reason?: ObservedElement['reason'] } = {},
): Pair {
  const origin = path.startsWith('~/') ? 'user' : 'project';
  const id = elementIdFor({ runtimeId: rid, origin, path, kind });
  return {
    observed: {
      id,
      native: { kind, origin, scope: origin },
      source: { path },
      inspectability: 'observable',
      metadata: {},
      status: observed.status ?? 'observed',
      ...(observed.reason !== undefined && { reason: observed.reason }),
    },
    resolved: {
      id,
      status: resolvedStatus,
      applicability: { type: 'project' },
      activation: 'always',
      resolution: { strategy: 'accumulate', reason: 'test' },
    },
  };
}

async function seedSnapshot(
  projectRoot: string,
  home: string,
  pairs: Pair[],
  diagnostics: ObservedSnapshot['diagnostics'] = [],
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
    diagnostics: [...diagnostics],
    completeness: 'partial',
    digests: { observed: 'sha256:x' },
  };
  const resolved: ResolvedSnapshot = {
    schemaVersion: '1',
    snapshotId: 'res_test' as ResolvedSnapshotId,
    observedSnapshotId: observed.snapshotId,
    runtime: { id: rid, version: '2.1.272' },
    resolution: { semanticsVersion: '1', confidence: 'verified' },
    elements: pairs.map((p) => p.resolved),
    relations: [],
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

describe('runReport', () => {
  it('renders the §26 report with counts, facets, and findings', async () => {
    const projectRoot = await tempDir('pfl-report-project-');
    const home = await tempDir('pfl-report-home-');
    await seedSnapshot(projectRoot, home, [
      pair('instructions', 'CLAUDE.md'),
      pair('memory', '~/.claude/projects/x/memory/MEMORY.md'),
      pair('permissions', '.claude/settings.json#permissions', 'shadowed'),
    ]);
    const { lines, logger } = fakeLogger();

    await runReport(projectRoot, { home }, logger);

    const output = lines.join('\n');
    expect(output).toContain('Harness Report');
    expect(output).toContain('Claude Code · owner/repo');
    expect(output).toContain('Effective elements      2');
    expect(output).toContain('Shadowed                1');
    expect(output).toContain('Semantic facets');
    expect(output).toContain('Instructions');
    expect(output).toContain('Memory');
    expect(output).toContain('Notable');
    expect(output).toContain('shadowed by a higher-precedence layer');
  });

  it('emits the same facts as JSON', async () => {
    const projectRoot = await tempDir('pfl-report-project-');
    const home = await tempDir('pfl-report-home-');
    await seedSnapshot(projectRoot, home, [
      pair('instructions', 'CLAUDE.md'),
      pair('permissions', '.claude/settings.json#permissions', 'shadowed'),
    ]);
    const { logger } = fakeLogger();

    const outcome = await runReport(projectRoot, { home, json: true }, logger);

    expect(outcome.data).toMatchObject({
      runtime: 'claude-code',
      runtimeName: 'Claude Code',
      project: { displayName: 'owner/repo' },
      stats: { effective: 1, shadowed: 1 },
    });
    expect(outcome.data.findings.map((finding: { rule: string }) => finding.rule)).toContain(
      'shadowed-element',
    );
    expect(outcome.data.resolvedSnapshotId).toBe('res_test');
    // The harness completeness travels in the envelope, not in `data`.
    expect(outcome.completeness).toBe('partial');
  });

  it('carries source path and kind for cited elements on each finding (#181)', async () => {
    const projectRoot = await tempDir('pfl-report-project-');
    const home = await tempDir('pfl-report-home-');
    const shadowed = pair('permissions', '.claude/settings.json#permissions', 'shadowed');
    const userShadowed = pair('permissions', '~/.claude/settings.json#permissions', 'shadowed');
    await seedSnapshot(projectRoot, home, [
      pair('instructions', 'CLAUDE.md'),
      shadowed,
      userShadowed,
    ]);
    const { logger } = fakeLogger();

    const outcome = await runReport(projectRoot, { home, json: true }, logger);

    const finding = outcome.data.findings.find(
      (entry: { rule: string }) => entry.rule === 'shadowed-element',
    );
    const expected = [
      {
        id: shadowed.observed.id,
        path: '.claude/settings.json#permissions',
        kind: 'permissions',
      },
      {
        id: userShadowed.observed.id,
        path: '~/.claude/settings.json#permissions',
        kind: 'permissions',
      },
    ].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(finding?.elementIds).toEqual(expected.map((entry) => entry.id));
    expect(finding?.elements).toEqual(expected);
  });

  it('explains why the snapshot is partial, and --explain dumps stored diagnostics (#169)', async () => {
    const projectRoot = await tempDir('pfl-report-project-');
    const home = await tempDir('pfl-report-home-');
    const skipped = pair('skills', '~/.claude/skills/linked/SKILL.md', 'unresolved', {
      status: 'skipped',
      reason: 'symlink-not-followed',
    });
    await seedSnapshot(
      projectRoot,
      home,
      [pair('instructions', 'CLAUDE.md'), skipped],
      [
        {
          severity: 'warning',
          code: 'duplicate-element-name',
          message: 'duplicate name "reviewer"',
          path: '~/.claude/plugins/market/plug/agents/reviewer.md',
        },
        { severity: 'info', code: 'path-not-found', message: 'no memory dir' },
      ],
    );
    const { lines, warns, logger } = fakeLogger();

    await runReport(projectRoot, { home }, logger);

    const output = [...lines, ...warns].join('\n');
    expect(output).toContain('⚠ scan completeness: partial');
    expect(output).toContain('1 element(s) not fully observed');
    expect(output).toContain(
      'skipped  symlink-not-followed  skills  ~/.claude/skills/linked/SKILL.md',
    );
    expect(output).toContain('1 warning/error diagnostic(s)');
    expect(output).toContain('warning duplicate-element-name');
    expect(output).toContain('--explain');
    // The info diagnostic stays out of the cause summary.
    expect(output).not.toContain('path-not-found');
  });

  it('emits the full stored diagnostics under --explain --json (#169)', async () => {
    const projectRoot = await tempDir('pfl-report-project-');
    const home = await tempDir('pfl-report-home-');
    const skipped = pair('skills', '~/.claude/skills/linked/SKILL.md', 'unresolved', {
      status: 'skipped',
      reason: 'symlink-not-followed',
    });
    await seedSnapshot(
      projectRoot,
      home,
      [skipped],
      [
        { severity: 'warning', code: 'w', message: 'warned' },
        { severity: 'info', code: 'i', message: 'noted' },
      ],
    );
    const { logger } = fakeLogger();

    const outcome = await runReport(projectRoot, { home, json: true, explain: true }, logger);

    expect(outcome.data.explanation).toMatchObject({
      causes: {
        elements: [
          {
            id: skipped.observed.id,
            path: '~/.claude/skills/linked/SKILL.md',
            kind: 'skills',
            status: 'skipped',
            reason: 'symlink-not-followed',
          },
        ],
        diagnostics: [{ severity: 'warning', code: 'w' }],
      },
      diagnostics: [
        { severity: 'warning', code: 'w' },
        { severity: 'info', code: 'i' },
      ],
    });
  });

  it('omits explanation without --explain', async () => {
    const projectRoot = await tempDir('pfl-report-project-');
    const home = await tempDir('pfl-report-home-');
    await seedSnapshot(projectRoot, home, [pair('instructions', 'CLAUDE.md')]);
    const { logger } = fakeLogger();

    const outcome = await runReport(projectRoot, { home, json: true }, logger);

    expect(outcome.data.explanation).toBeUndefined();
  });

  it('fails clearly on an unknown snapshot id', async () => {
    const projectRoot = await tempDir('pfl-report-project-');
    const home = await tempDir('pfl-report-home-');
    await seedSnapshot(projectRoot, home, [pair('instructions', 'CLAUDE.md')]);
    const { logger } = fakeLogger();

    await expect(
      runReport(projectRoot, { home, snapshot: 'res_missing' }, logger),
    ).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
    });
  });

  it('surfaces store diagnostics encountered while resolving a named snapshot', async () => {
    const projectRoot = await tempDir('pfl-report-project-');
    const home = await tempDir('pfl-report-home-');
    await seedSnapshot(projectRoot, home, [pair('instructions', 'CLAUDE.md')]);
    const projectId = (await resolveProjectContext(projectRoot)).id;
    await writeFile(join(snapshotsDir(projectId, home), 'res_corrupt.json'), '{ not json');
    const { warns, logger } = fakeLogger();

    await runReport(projectRoot, { home, snapshot: 'res_test' }, logger);

    // #82: the malformed artifact reports its specific diagnostic.
    expect(warns.join('\n')).toContain('invalid-snapshot');
  });

  it('fails clearly when no snapshot is stored', async () => {
    const projectRoot = await tempDir('pfl-report-project-');
    const home = await tempDir('pfl-report-home-');
    const { logger } = fakeLogger();

    await expect(runReport(projectRoot, { home }, logger)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
    });
  });
});
