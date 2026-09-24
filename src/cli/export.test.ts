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
import type { Diagnostic } from '../core/diagnostics.js';
import type { Finding, Interpretation } from '../core/interpretation.js';
import type { NativeOrigin, ObservedElement, ObservedSnapshot } from '../core/observed.js';
import type { ResolvedElement, ResolvedSnapshot, ResolvedStatus } from '../core/resolved.js';
import { resolveProjectContext } from '../discovery/project-identity.js';
import {
  writeInterpretation,
  writeLatestPointer,
  writeObservedSnapshot,
  writeResolvedSnapshot,
} from '../snapshot/store.js';
import { EXIT_CODES } from './exit-codes.js';
import { runExport } from './export.js';

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
    omitPath?: boolean;
  } = {},
): Pair {
  const origin = options.origin ?? (path.startsWith('~/') ? 'user' : 'project');
  const id = elementIdFor({ runtimeId: rid, origin, path, kind });
  return {
    observed: {
      id,
      native: { kind, origin, scope: origin },
      source: options.omitPath === true ? {} : { path },
      inspectability: 'observable',
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
  options: {
    relations?: ResolvedSnapshot['relations'];
    findings?: Finding[];
    storeInterpretation?: boolean;
    completeness?: ObservedSnapshot['completeness'];
    observedDiagnostics?: Diagnostic[];
    resolvedDiagnostics?: Diagnostic[];
  } = {},
): Promise<{ observed: ObservedSnapshot; resolved: ResolvedSnapshot }> {
  const projectId = (await resolveProjectContext(projectRoot)).id;
  const observed: ObservedSnapshot = {
    schemaVersion: '1',
    snapshotId: generateObservedSnapshotId(),
    capturedAt: '2026-09-16T00:00:00.000Z',
    project: { id: projectId, displayName: 'owner/repo', root: projectRoot },
    runtime: { id: rid, version: '2.1.272' },
    adapter: { id: 'claude-code', version: '0.1.0', runtimeCompatibility: 'verified' },
    elements: pairs.map((p) => p.observed),
    diagnostics: options.observedDiagnostics ?? [],
    completeness: options.completeness ?? 'complete',
    digests: { observed: 'sha256:x' },
  };
  const resolved: ResolvedSnapshot = {
    schemaVersion: '1',
    snapshotId: 'res_test' as ResolvedSnapshotId,
    observedSnapshotId: observed.snapshotId,
    runtime: { id: rid, version: '2.1.272' },
    resolution: { semanticsVersion: '1', confidence: 'verified' },
    elements: pairs.map((p) => p.resolved),
    relations: [...(options.relations ?? [])],
    effectiveElementIds: [],
    diagnostics: options.resolvedDiagnostics ?? [],
    digests: { harnessContent: 'sha256:h', resolvedSnapshot: 'sha256:r' },
  };
  await writeObservedSnapshot(projectId, observed, home);
  await writeResolvedSnapshot(projectId, resolved, home);
  if (options.storeInterpretation === true) {
    const interpretation: Interpretation = {
      schemaVersion: '1',
      interpretationId: 'int_test' as never,
      resolvedSnapshotId: resolved.snapshotId,
      classifier: { id: 'pfl-native', version: '5' },
      elements: pairs.map((p) => ({
        elementId: p.observed.id,
        facets: [],
        confidence: 'high',
        reason: 'test',
      })),
      stats: {
        observed: pairs.length,
        effective: pairs.length,
        shadowed: 0,
        conditional: 0,
        opaque: 0,
        byFacet: {},
      },
      findings: options.findings ?? [],
    };
    await writeInterpretation(projectId, interpretation, home);
  }
  await writeLatestPointer(
    projectId,
    { observed: observed.snapshotId, resolved: resolved.snapshotId },
    home,
  );
  return { observed, resolved };
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

describe('runExport', () => {
  it('joins every observed element to its resolved and interpretation counterpart', async () => {
    const projectRoot = await tempDir('pfl-export-project-');
    const home = await tempDir('pfl-export-home-');
    const winner = pair('permissions', '.claude/settings.json#permissions');
    const loser = pair('permissions', '~/.claude/settings.json#permissions', {
      origin: 'user',
      status: 'shadowed',
    });
    const finding: Finding = {
      rule: 'shadowed-element',
      message: '1 element(s) are shadowed by a higher-precedence layer',
      elementIds: [loser.observed.id],
    };
    await seed(projectRoot, home, [winner, loser], {
      relations: [{ type: 'shadows', from: winner.observed.id, to: loser.observed.id }],
      findings: [finding],
      storeInterpretation: true,
    });
    const { logger } = fakeLogger();

    const outcome = await runExport(projectRoot, { home, json: true }, logger);

    // 1. Every observed element appears.
    expect(outcome.data.elements.map((e) => e.id).sort()).toEqual(
      [winner.observed.id, loser.observed.id].sort(),
    );
    // 2. Resolved / interpretation are joined to the right id.
    const loserElement = outcome.data.elements.find((e) => e.id === loser.observed.id);
    expect(loserElement?.resolved?.status).toBe('shadowed');
    expect(loserElement?.interpretation?.elementId).toBe(loser.observed.id);
    // 3. Relations are not dropped.
    expect(outcome.data.relations).toEqual([
      { type: 'shadows', from: winner.observed.id, to: loser.observed.id },
    ]);
    // 4. Findings are not dropped.
    expect(outcome.data.findings).toEqual([finding]);
    // 5. Completeness is preserved (envelope-level).
    expect(outcome.completeness).toBe('complete');
    // 6. Runtime / resolution / classifier provenance is preserved.
    expect(outcome.data.runtime).toEqual({
      id: 'claude-code',
      version: '2.1.272',
      adapter: { id: 'claude-code', version: '0.1.0', runtimeCompatibility: 'verified' },
    });
    expect(outcome.data.resolution).toEqual({ semanticsVersion: '1', confidence: 'verified' });
    expect(outcome.data.interpretation).toEqual({
      classifier: { id: 'pfl-native', version: '5' },
      origin: 'stored',
    });
  });

  it('marks resolved and interpretation null rather than dropping an unjoined element', async () => {
    const projectRoot = await tempDir('pfl-export-project-');
    const home = await tempDir('pfl-export-home-');
    const solo = pair('instructions', 'CLAUDE.md');
    // No stored interpretation: it will be recomputed, so `interpretation` on
    // the element is populated by the classifier, not left null. To exercise
    // the "no resolved counterpart" path directly, seed a resolved snapshot
    // whose elements array omits the element.
    const projectId = (await resolveProjectContext(projectRoot)).id;
    const observed: ObservedSnapshot = {
      schemaVersion: '1',
      snapshotId: generateObservedSnapshotId(),
      capturedAt: '2026-09-16T00:00:00.000Z',
      project: { id: projectId, displayName: 'owner/repo', root: projectRoot },
      runtime: { id: rid, version: '2.1.272' },
      adapter: { id: 'claude-code', version: '0.1.0', runtimeCompatibility: 'verified' },
      elements: [solo.observed],
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
      elements: [],
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
    const { logger } = fakeLogger();

    const outcome = await runExport(projectRoot, { home, json: true }, logger);

    expect(outcome.data.elements).toHaveLength(1);
    expect(outcome.data.elements[0]?.resolved).toBeNull();
  });

  it('names a recomputed interpretation, not a stored one, when none is persisted', async () => {
    const projectRoot = await tempDir('pfl-export-project-');
    const home = await tempDir('pfl-export-home-');
    await seed(projectRoot, home, [pair('instructions', 'CLAUDE.md')]);
    const { logger } = fakeLogger();

    const outcome = await runExport(projectRoot, { home, json: true }, logger);

    expect(outcome.data.interpretation.origin).toBe('recomputed');
  });

  it('surfaces partial completeness rather than hiding it', async () => {
    const projectRoot = await tempDir('pfl-export-project-');
    const home = await tempDir('pfl-export-home-');
    await seed(projectRoot, home, [pair('instructions', 'CLAUDE.md')], {
      completeness: 'partial',
    });
    const { logger } = fakeLogger();

    const outcome = await runExport(projectRoot, { home, json: true }, logger);

    expect(outcome.completeness).toBe('partial');
  });

  it('carries the stored observed and resolved diagnostics, not only store-read ones', async () => {
    const projectRoot = await tempDir('pfl-export-project-');
    const home = await tempDir('pfl-export-home-');
    const observedDiagnostic: Diagnostic = {
      severity: 'warning',
      code: 'unreadable-file',
      message: 'could not read file: .claude/skills/broken/SKILL.md',
      path: '.claude/skills/broken/SKILL.md',
    };
    const resolvedDiagnostic: Diagnostic = {
      severity: 'warning',
      code: 'unverified-runtime-version',
      message: 'the runtime version is outside the verified adapter range',
    };
    await seed(projectRoot, home, [pair('instructions', 'CLAUDE.md')], {
      completeness: 'partial',
      observedDiagnostics: [observedDiagnostic],
      resolvedDiagnostics: [resolvedDiagnostic],
    });
    const { logger } = fakeLogger();

    const outcome = await runExport(projectRoot, { home, json: true }, logger);

    // A consumer must be able to tell *why* the export is partial without a
    // separate `report --explain` call.
    expect(outcome.diagnostics).toContainEqual(observedDiagnostic);
    expect(outcome.diagnostics).toContainEqual(resolvedDiagnostic);
  });

  it('redacts the home directory out of a source path', async () => {
    const projectRoot = await tempDir('pfl-export-project-');
    const home = await tempDir('pfl-export-home-');
    const userElement = pair('memory', `${home}/.claude/CLAUDE.md`, { origin: 'user' });
    await seed(projectRoot, home, [userElement]);
    const { logger } = fakeLogger();

    const outcome = await runExport(projectRoot, { home, json: true }, logger);

    const element = outcome.data.elements[0];
    expect(element?.observed.source.path).toBe('~/.claude/CLAUDE.md');
    expect(element?.observed.source.path).not.toContain(home);
  });

  it('produces a deterministic element order independent of discovery order', async () => {
    const projectRoot = await tempDir('pfl-export-project-');
    const home = await tempDir('pfl-export-home-');
    const b = pair('instructions', 'b.md');
    const a = pair('instructions', 'a.md');
    await seed(projectRoot, home, [b, a]);
    const { logger } = fakeLogger();

    const outcome = await runExport(projectRoot, { home, json: true }, logger);

    const ids = outcome.data.elements.map((e) => e.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('emits human-readable output without --json', async () => {
    const projectRoot = await tempDir('pfl-export-project-');
    const home = await tempDir('pfl-export-home-');
    await seed(projectRoot, home, [pair('instructions', 'CLAUDE.md')]);
    const { lines, logger } = fakeLogger();

    await runExport(projectRoot, { home }, logger);

    const output = lines.join('\n');
    expect(output).toContain('Elements     1');
    expect(output).toContain('--json to consume it');
  });

  it('fails closed when no snapshot is stored', async () => {
    const projectRoot = await tempDir('pfl-export-project-');
    const home = await tempDir('pfl-export-home-');
    const { logger } = fakeLogger();

    await expect(runExport(projectRoot, { home, json: true }, logger)).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONFIG_ERROR,
    });
  });
});
