import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  elementIdFor,
  generateInterpretationId,
  generateObservedSnapshotId,
  generateResolvedSnapshotId,
  runtimeId,
} from '../core/ids.js';
import type { HarnessFacet } from '../core/facets.js';
import type { Finding, Interpretation } from '../core/interpretation.js';
import type { NativeOrigin, ObservedElement, ObservedSnapshot } from '../core/observed.js';
import type { ResolvedElement, ResolvedSnapshot, ResolvedStatus } from '../core/resolved.js';
import { resolveProjectContext } from '../discovery/project-identity.js';
import {
  writeLatestPointer,
  writeObservedSnapshot,
  writeResolvedSnapshot,
} from '../snapshot/store.js';
import { computeDiff, runDiff } from './diff.js';
import type { InterpretedRun } from './read.js';

const tempDirs: string[] = [];

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
  rid: ReturnType<typeof runtimeId>,
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

function makeRun(options: {
  projectId: string;
  runtimeId: string;
  runtimeVersion: string | null;
  semanticsVersion?: string;
  contentDigest: string;
  pairs: Pair[];
  facets?: Map<string, HarnessFacet[]>;
  relations?: ResolvedSnapshot['relations'];
  findings?: Interpretation['findings'];
  classifierVersion?: string;
}): InterpretedRun {
  const rid = runtimeId(options.runtimeId);
  const observedSnapshotId = generateObservedSnapshotId();
  const resolvedSnapshotId = generateResolvedSnapshotId();
  const observed: ObservedSnapshot = {
    schemaVersion: '1',
    snapshotId: observedSnapshotId,
    capturedAt: '2026-09-16T00:00:00.000Z',
    project: { id: options.projectId, displayName: 'owner/repo', root: '/repo' },
    runtime: { id: rid, version: options.runtimeVersion },
    adapter: { id: options.runtimeId, version: '0.1.0', runtimeCompatibility: 'verified' },
    elements: options.pairs.map((p) => p.observed),
    diagnostics: [],
    completeness: 'complete',
    digests: { observed: options.contentDigest },
  };
  const resolved: ResolvedSnapshot = {
    schemaVersion: '1',
    snapshotId: resolvedSnapshotId,
    observedSnapshotId,
    runtime: { id: rid, version: options.runtimeVersion },
    resolution: { semanticsVersion: options.semanticsVersion ?? '1', confidence: 'verified' },
    elements: options.pairs.map((p) => p.resolved),
    relations: options.relations ?? [],
    effectiveElementIds: [],
    diagnostics: [],
    digests: {
      harnessContent: options.contentDigest,
      resolvedSnapshot: `sha256:res-${resolvedSnapshotId}`,
    },
  };
  const interpretation: Interpretation = {
    schemaVersion: '1',
    interpretationId: generateInterpretationId(),
    resolvedSnapshotId,
    classifier: { id: 'pfl-native', version: options.classifierVersion ?? '1' },
    elements: options.pairs.map((p) => ({
      elementId: p.observed.id,
      facets: options.facets?.get(p.observed.id) ?? [],
      confidence: 'high',
      reason: 'test',
    })),
    stats: {
      observed: options.pairs.length,
      effective: 0,
      shadowed: 0,
      conditional: 0,
      opaque: 0,
      byFacet: {},
    },
    findings: options.findings ?? [],
  };
  return {
    observed,
    resolved,
    interpretation,
    interpretationOrigin: 'stored',
    diagnostics: [],
    canonicalProjectRoot: '',
  };
}

describe('computeDiff', () => {
  const rid = runtimeId('claude-code');

  it('refuses snapshots from different projects', () => {
    const a = makeRun({
      projectId: 'p1',
      runtimeId: 'claude-code',
      runtimeVersion: '1',
      contentDigest: 'sha256:a',
      pairs: [],
    });
    const b = makeRun({
      projectId: 'p2',
      runtimeId: 'claude-code',
      runtimeVersion: '1',
      contentDigest: 'sha256:a',
      pairs: [],
    });
    expect(() => computeDiff(a, b)).toThrow(/different projects/);
  });

  it('refuses snapshots from different runtimes', () => {
    const a = makeRun({
      projectId: 'p1',
      runtimeId: 'claude-code',
      runtimeVersion: '1',
      contentDigest: 'sha256:a',
      pairs: [],
    });
    const b = makeRun({
      projectId: 'p1',
      runtimeId: 'codex',
      runtimeVersion: '1',
      contentDigest: 'sha256:a',
      pairs: [],
    });
    expect(() => computeDiff(a, b)).toThrow(/different runtimes/);
  });

  it('reports runtime and semantics version differences', () => {
    const a = makeRun({
      projectId: 'p1',
      runtimeId: 'claude-code',
      runtimeVersion: '2.1.272',
      semanticsVersion: '1',
      contentDigest: 'sha256:a',
      pairs: [],
    });
    const b = makeRun({
      projectId: 'p1',
      runtimeId: 'claude-code',
      runtimeVersion: '2.2.0',
      semanticsVersion: '2',
      contentDigest: 'sha256:a',
      pairs: [],
    });

    const result = computeDiff(a, b);

    expect(result.versionNotes.join('\n')).toContain('2.1.272 → 2.2.0');
    expect(result.versionNotes.join('\n')).toContain('semantics differ: 1 → 2');
  });

  it('detects an opaque-only change despite an unchanged content digest', () => {
    const opaque = pair(rid, 'runtime-provided-instructions', '(builtin) layers', {
      origin: 'builtin',
      inspectability: 'opaque',
    });
    const a = makeRun({
      projectId: 'p1',
      runtimeId: 'claude-code',
      runtimeVersion: '1',
      contentDigest: 'sha256:same',
      pairs: [],
    });
    const b = makeRun({
      projectId: 'p1',
      runtimeId: 'claude-code',
      runtimeVersion: '1',
      contentDigest: 'sha256:same',
      pairs: [opaque],
    });

    const result = computeDiff(a, b);

    expect(result.structural.added).toBe(1);
  });

  it('treats a kind change for the same path as a distinct element', () => {
    // Kind is part of the id (ADR 0003), so a different kind at one path is a
    // different element: it cannot silently share an id and be reported as a
    // one-element "change". It is a removal plus an addition.
    const a = makeRun({
      projectId: 'p1',
      runtimeId: 'claude-code',
      runtimeVersion: '1',
      contentDigest: 'sha256:a',
      pairs: [pair(rid, 'instructions', 'CLAUDE.md')],
    });
    const b = makeRun({
      projectId: 'p1',
      runtimeId: 'claude-code',
      runtimeVersion: '1',
      contentDigest: 'sha256:b',
      pairs: [pair(rid, 'rules', 'CLAUDE.md')],
    });

    const result = computeDiff(a, b);

    expect(result.structural.removed).toBe(1);
    expect(result.structural.added).toBe(1);
    expect(result.structural.changed).toBe(0);
  });

  it('still reports a kind change between two snapshots that share an id', () => {
    // Snapshots captured under the previous derivation carry ids that covered
    // runtime, origin and path only, so one id can sit beside two kinds: the
    // `.codex/skills/AGENTS.md` case, recorded as `instructions` in one capture
    // and as `skills` in another. The compatibility promise is that an old
    // snapshot diffs against another old snapshot exactly as before, so the id
    // here is minted once and both kinds are recorded against it. Which digest
    // mints it does not matter to the comparison under test.
    const legacyPath = '.codex/skills/AGENTS.md';
    const previousDerivationPair = (kind: string): Pair => {
      const id = elementIdFor({
        runtimeId: rid,
        origin: 'project',
        path: legacyPath,
        kind: 'instructions',
      });
      return {
        observed: {
          id,
          native: { kind, origin: 'project', scope: 'project' },
          source: { path: legacyPath },
          inspectability: 'observable',
          metadata: {},
          status: 'observed',
        },
        resolved: {
          id,
          status: 'effective',
          applicability: { type: 'project' },
          activation: 'always',
          resolution: { strategy: 'accumulate', reason: 'test' },
        },
      };
    };

    const a = makeRun({
      projectId: 'p1',
      runtimeId: 'codex',
      runtimeVersion: '1',
      contentDigest: 'sha256:a',
      pairs: [previousDerivationPair('instructions')],
    });
    const b = makeRun({
      projectId: 'p1',
      runtimeId: 'codex',
      runtimeVersion: '1',
      contentDigest: 'sha256:b',
      pairs: [previousDerivationPair('skills')],
    });

    const result = computeDiff(a, b);

    expect(result.structural.changed).toBe(1);
    expect(result.structural.added).toBe(0);
    expect(result.structural.removed).toBe(0);
  });

  it('returns id lists in a deterministic order', () => {
    const one = pair(rid, 'skills', '.claude/skills/a/SKILL.md');
    const two = pair(rid, 'skills', '.claude/skills/b/SKILL.md');
    const forward = makeRun({
      projectId: 'p1',
      runtimeId: 'claude-code',
      runtimeVersion: '1',
      contentDigest: 'sha256:a',
      pairs: [one],
    });
    const reversed = makeRun({
      projectId: 'p1',
      runtimeId: 'claude-code',
      runtimeVersion: '1',
      contentDigest: 'sha256:b',
      pairs: [two, one],
    });
    const ordered = makeRun({
      projectId: 'p1',
      runtimeId: 'claude-code',
      runtimeVersion: '1',
      contentDigest: 'sha256:b',
      pairs: [one, two],
    });

    const first = computeDiff(forward, reversed);
    const second = computeDiff(forward, ordered);

    expect(first.structural.addedIds).toEqual(second.structural.addedIds);
  });

  it('reports a classifier version difference', () => {
    const a = makeRun({
      projectId: 'p1',
      runtimeId: 'claude-code',
      runtimeVersion: '1',
      classifierVersion: '1',
      contentDigest: 'sha256:a',
      pairs: [],
    });
    const b = makeRun({
      projectId: 'p1',
      runtimeId: 'claude-code',
      runtimeVersion: '1',
      classifierVersion: '2',
      contentDigest: 'sha256:b',
      pairs: [],
    });

    const result = computeDiff(a, b);

    expect(result.versionNotes.join('\n')).toContain('classifier version differs: 1 → 2');
  });

  it('diffs relations as added and removed arrays', () => {
    const one = pair(rid, 'instructions', 'CLAUDE.md');
    const two = pair(rid, 'skills', '.claude/skills/a/SKILL.md');
    const base = {
      projectId: 'p1',
      runtimeId: 'claude-code',
      runtimeVersion: '1',
      pairs: [one, two],
    };
    const a = makeRun({
      ...base,
      contentDigest: 'sha256:a',
      relations: [{ type: 'shadows', from: two.observed.id, to: one.observed.id }],
    });
    const b = makeRun({
      ...base,
      contentDigest: 'sha256:b',
      relations: [{ type: 'shadows', from: one.observed.id, to: two.observed.id }],
    });

    const result = computeDiff(a, b);

    expect(result.relations.removed).toEqual([
      { type: 'shadows', from: two.observed.id, to: one.observed.id },
    ]);
    expect(result.relations.added).toEqual([
      { type: 'shadows', from: one.observed.id, to: two.observed.id },
    ]);
  });

  it('diffs findings as added and removed arrays', () => {
    const one = pair(rid, 'memory', '~/.claude/memory/MEMORY.md');
    const finding: Finding = {
      rule: 'memory-enabled',
      message: '1 memory element(s) are present',
      elementIds: [one.observed.id],
    };
    const base = {
      projectId: 'p1',
      runtimeId: 'claude-code',
      runtimeVersion: '1',
      pairs: [one],
    };
    const a = makeRun({ ...base, contentDigest: 'sha256:a', findings: [finding] });
    const b = makeRun({ ...base, contentDigest: 'sha256:b', findings: [] });

    const result = computeDiff(a, b);

    expect(result.findings.removed).toEqual([finding]);
    expect(result.findings.added).toEqual([]);
  });

  it('computes per-facet deltas including zero', () => {
    const skill = pair(rid, 'skills', '.claude/skills/a/SKILL.md');
    const instructions = pair(rid, 'instructions', 'CLAUDE.md');
    const b = makeRun({
      projectId: 'p1',
      runtimeId: 'claude-code',
      runtimeVersion: '1',
      contentDigest: 'sha256:b',
      pairs: [instructions],
    });
    const facets = new Map<string, HarnessFacet[]>([
      [skill.observed.id, ['knowledge', 'actions']],
      [instructions.observed.id, ['instructions']],
    ]);
    const aFacets = makeRun({
      projectId: 'p1',
      runtimeId: 'claude-code',
      runtimeVersion: '1',
      contentDigest: 'sha256:a',
      pairs: [skill, instructions],
      facets,
    });

    const result = computeDiff(aFacets, b);

    expect(result.facetDeltas.actions).toBe(-1);
    expect(result.facetDeltas.knowledge).toBe(-1);
    expect(result.facetDeltas.memory).toBe(0);
  });
});

interface SeedOptions {
  runtimeVersion?: string;
  semanticsVersion?: string;
  statuses?: Map<string, ResolvedStatus>;
}

async function seedRun(
  projectRoot: string,
  home: string,
  pairs: Pair[],
  options: SeedOptions = {},
): Promise<{ observedId: string; resolvedId: string }> {
  const projectId = (await resolveProjectContext(projectRoot)).id;
  const rid = runtimeId('claude-code');
  const observedSnapshotId = generateObservedSnapshotId();
  const resolvedSnapshotId = generateResolvedSnapshotId();
  const observed: ObservedSnapshot = {
    schemaVersion: '1',
    snapshotId: observedSnapshotId,
    capturedAt: '2026-09-16T00:00:00.000Z',
    project: { id: projectId, displayName: 'owner/repo', root: projectRoot },
    runtime: { id: rid, version: options.runtimeVersion ?? '2.1.272' },
    adapter: { id: 'claude-code', version: '0.1.0', runtimeCompatibility: 'verified' },
    elements: pairs.map((p) => p.observed),
    diagnostics: [],
    completeness: 'complete',
    digests: { observed: 'sha256:content' },
  };
  const resolved: ResolvedSnapshot = {
    schemaVersion: '1',
    snapshotId: resolvedSnapshotId,
    observedSnapshotId,
    runtime: { id: rid, version: options.runtimeVersion ?? '2.1.272' },
    resolution: { semanticsVersion: options.semanticsVersion ?? '1', confidence: 'verified' },
    elements: pairs.map((p) => ({
      ...p.resolved,
      status: options.statuses?.get(p.resolved.id) ?? p.resolved.status,
    })),
    relations: [],
    effectiveElementIds: [],
    diagnostics: [],
    digests: {
      harnessContent: 'sha256:content',
      resolvedSnapshot: `sha256:res-${resolvedSnapshotId}`,
    },
  };
  await writeObservedSnapshot(projectId, observed, home);
  await writeResolvedSnapshot(projectId, resolved, home);
  await writeLatestPointer(
    projectId,
    { observed: observedSnapshotId, resolved: resolvedSnapshotId },
    home,
  );
  return { observedId: observedSnapshotId, resolvedId: resolvedSnapshotId };
}

describe('runDiff', () => {
  it('produces an all-zero diff for identical snapshots', async () => {
    const projectRoot = await tempDir('pfl-diff-project-');
    const home = await tempDir('pfl-diff-home-');
    const rid = runtimeId('claude-code');
    const instructions = pair(rid, 'instructions', 'CLAUDE.md');
    const a = await seedRun(projectRoot, home, [instructions]);
    const b = await seedRun(projectRoot, home, [instructions]);
    const { lines, logger } = fakeLogger();

    await runDiff(projectRoot, a.resolvedId, b.resolvedId, { home }, logger);

    const output = lines.join('\n');
    expect(output).toContain('+ 0 added');
    expect(output).toContain('+ 0 newly effective');
    expect(output).toContain('Instructions  0');
  });

  it('shows a shadowed-to-effective transition at the effective level only', async () => {
    const projectRoot = await tempDir('pfl-diff-project-');
    const home = await tempDir('pfl-diff-home-');
    const rid = runtimeId('claude-code');
    const instructions = pair(rid, 'instructions', 'CLAUDE.md');
    const permissions = pair(rid, 'permissions', '.claude/settings.json#permissions');
    const a = await seedRun(projectRoot, home, [instructions, permissions], {
      statuses: new Map([[permissions.resolved.id, 'shadowed']]),
    });
    const b = await seedRun(projectRoot, home, [instructions, permissions], {
      statuses: new Map([[permissions.resolved.id, 'effective']]),
    });
    const { lines, logger } = fakeLogger();

    await runDiff(projectRoot, a.resolvedId, b.resolvedId, { home }, logger);

    const output = lines.join('\n');
    expect(output).toContain('+ 1 newly effective');
    expect(output).toContain('+ 0 added');
    expect(output).not.toMatch(/\b(improved|regressed|better|worse)\b/i);
  });

  it('includes the observed snapshot ids and the diff arrays in JSON data', async () => {
    const projectRoot = await tempDir('pfl-diff-project-');
    const home = await tempDir('pfl-diff-home-');
    const rid = runtimeId('claude-code');
    const instructions = pair(rid, 'instructions', 'CLAUDE.md');
    const a = await seedRun(projectRoot, home, [instructions]);
    const b = await seedRun(projectRoot, home, [instructions]);
    const { logger } = fakeLogger();

    const outcome = await runDiff(
      projectRoot,
      a.resolvedId,
      b.resolvedId,
      { home, json: true },
      logger,
    );

    expect(outcome.data.observedSnapshotIdA).toBe(a.observedId);
    expect(outcome.data.observedSnapshotIdB).toBe(b.observedId);
    expect(outcome.data.resolvedSnapshotIdA).toBe(a.resolvedId);
    expect(outcome.data.relations).toEqual({ added: [], removed: [] });
    expect(outcome.data.findings).toEqual({ added: [], removed: [] });
    expect(outcome.completeness).toBe('complete');
  });
});
