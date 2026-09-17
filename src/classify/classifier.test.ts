import { describe, expect, it } from 'vitest';
import type { HarnessFacet } from '../core/facets.js';
import {
  elementIdFor,
  generateObservedSnapshotId,
  runtimeId,
  type ResolvedSnapshotId,
} from '../core/ids.js';
import type { ObservedElement, ObservedSnapshot } from '../core/observed.js';
import type { ResolvedElement, ResolvedSnapshot, ResolvedStatus } from '../core/resolved.js';
import { CLASSIFIER_ID, CLASSIFIER_VERSION, classify } from './classifier.js';

const rid = runtimeId('claude-code');

function makePair(kind: string, path: string, status: ResolvedStatus = 'effective') {
  const id = elementIdFor({ runtimeId: rid, origin: 'project', path });
  const observed: ObservedElement = {
    id,
    native: { kind, origin: 'project', scope: 'project' },
    source: { path },
    inspectability: kind === 'runtime-provided-instructions' ? 'opaque' : 'observable',
    metadata: {},
    status: 'observed',
  };
  const resolved: ResolvedElement = {
    id,
    status,
    applicability: { type: 'project' },
    activation: 'always',
    resolution: { strategy: 'accumulate', reason: 'test' },
  };
  return { observed, resolved };
}

function snapshots(observedElements: ObservedElement[], resolvedElements: ResolvedElement[]) {
  const observed: ObservedSnapshot = {
    schemaVersion: '1',
    snapshotId: generateObservedSnapshotId(),
    capturedAt: '2026-09-16T00:00:00.000Z',
    project: { id: 'proj', displayName: 'owner/repo', root: '/repo' },
    runtime: { id: rid, version: '2.1.272' },
    adapter: { id: 'claude-code', version: '0.1.0', runtimeCompatibility: 'verified' },
    elements: observedElements,
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
    elements: resolvedElements,
    relations: [],
    effectiveElementIds: [],
    diagnostics: [],
    digests: { harnessContent: 'sha256:h', resolvedSnapshot: 'sha256:r' },
  };
  return { observed, resolved };
}

function facetsOf(path: string, result: ReturnType<typeof classify>): HarnessFacet[] {
  const element = result.elements.find(
    (entry) => entry.elementId === elementIdFor({ runtimeId: rid, origin: 'project', path }),
  );
  if (element === undefined) throw new Error('expected a classified element');
  return element.facets;
}

describe('classify', () => {
  it('maps native kinds to the six facets with a reason', () => {
    const pairs = [
      makePair('instructions', 'CLAUDE.md'),
      makePair('skills', '.claude/skills/foo/SKILL.md'),
      makePair('subagents', '.claude/agents/reviewer.md'),
      makePair('hooks', '.claude/settings.json#hooks'),
      makePair('permissions', '.claude/settings.json#permissions'),
      makePair('memory', '~/.claude/projects/x/memory/MEMORY.md'),
    ];
    const { observed, resolved } = snapshots(
      pairs.map((p) => p.observed),
      pairs.map((p) => p.resolved),
    );

    const result = classify(observed, resolved);
    const byId = new Map(result.elements.map((e) => [e.elementId, e]));

    const expectFacets = (path: string, facets: HarnessFacet[]) =>
      expect(byId.get(elementIdFor({ runtimeId: rid, origin: 'project', path }))?.facets).toEqual(
        facets,
      );
    expectFacets('CLAUDE.md', ['instructions']);
    expectFacets('.claude/skills/foo/SKILL.md', ['knowledge', 'actions']);
    expectFacets('.claude/agents/reviewer.md', ['delegation']);
    expectFacets('.claude/settings.json#hooks', ['controls']);
    expectFacets('.claude/settings.json#permissions', ['controls']);
    expectFacets('~/.claude/projects/x/memory/MEMORY.md', ['memory']);

    for (const element of result.elements) {
      expect(element.reason).toBeTruthy();
    }
  });

  it('records an opaque runtime layer with unknown confidence', () => {
    const opaque = makePair('runtime-provided-instructions', '(builtin) layers');
    const { observed, resolved } = snapshots([opaque.observed], [opaque.resolved]);

    const result = classify(observed, resolved);
    const element = result.elements[0];

    expect(element?.facets).toEqual(['instructions']);
    expect(element?.confidence).toBe('unknown');
  });

  it('does not guess a facet for an unknown kind', () => {
    const unknown = makePair('mystery-kind', '.claude/mystery');
    const { observed, resolved } = snapshots([unknown.observed], [unknown.resolved]);

    const result = classify(observed, resolved);

    expect(result.elements[0]).toMatchObject({ facets: [], confidence: 'unknown' });
    expect(result.elements[0]?.reason).toContain('mystery-kind');
  });

  it('classifies model configuration and drops the withdrawn Codex rows', () => {
    const model = makePair('model-configuration', '~/.codex/config.toml#model');
    const multi = makePair('multi-agent-configuration', '~/.codex/agents');
    const dependencies = makePair('skill-dependencies', '~/.codex/skills/x/SKILL.md');
    const all = [model, multi, dependencies];
    const { observed, resolved } = snapshots(
      all.map((pair) => pair.observed),
      all.map((pair) => pair.resolved),
    );

    const result = classify(observed, resolved);
    const byId = new Map(result.elements.map((element) => [element.elementId, element]));

    expect(byId.get(model.observed.id)).toMatchObject({
      facets: ['controls'],
      confidence: 'medium',
    });
    // Withdrawn for the verified range, so no row remains and the kind is
    // recorded as unclassified rather than guessed.
    expect(byId.get(multi.observed.id)).toMatchObject({ facets: [], confidence: 'unknown' });
    expect(byId.get(dependencies.observed.id)).toMatchObject({ facets: [], confidence: 'unknown' });
  });

  it('computes stats: counts and per-facet totals', () => {
    const effective = makePair('instructions', 'CLAUDE.md', 'effective');
    const shadowed = makePair('permissions', '.claude/settings.json#permissions', 'shadowed');
    const conditional = makePair('skills', '.claude/skills/a/SKILL.md', 'conditional');
    const opaque = makePair('runtime-provided-instructions', '(builtin) layers');
    const all = [effective, shadowed, conditional, opaque];
    const { observed, resolved } = snapshots(
      all.map((p) => p.observed),
      all.map((p) => p.resolved),
    );

    const { stats } = classify(observed, resolved);

    expect(stats).toMatchObject({
      observed: 4,
      effective: 2, // the opaque layer is effective too
      shadowed: 1,
      conditional: 1,
      opaque: 1,
    });
    expect(stats.byFacet.instructions).toBe(2);
    expect(stats.byFacet.controls).toBe(1);
    expect(stats.byFacet.knowledge).toBe(1);
    expect(stats.byFacet.actions).toBe(1);
  });

  it('includes an observed element that the resolved snapshot omits', () => {
    const only = makePair('instructions', 'orphan.md');
    const { observed, resolved } = snapshots([only.observed], []);

    const result = classify(observed, resolved);

    expect(result.elements.map((element) => element.elementId)).toEqual([only.observed.id]);
    expect(result.elements[0]?.facets).toEqual(['instructions']);
  });

  it('is deterministic and independent of input order', () => {
    const a = makePair('instructions', 'CLAUDE.md');
    const b = makePair('skills', '.claude/skills/x/SKILL.md');
    const forward = snapshots([a.observed, b.observed], [a.resolved, b.resolved]);
    const reversed = snapshots([b.observed, a.observed], [b.resolved, a.resolved]);

    const first = classify(forward.observed, forward.resolved);
    const second = classify(reversed.observed, reversed.resolved);

    expect(first).toEqual(second);
    expect(first.classifier).toEqual({ id: CLASSIFIER_ID, version: CLASSIFIER_VERSION });
  });

  it('sets every element in a known facet group', () => {
    const pairs = [
      makePair('instructions', 'CLAUDE.md'),
      makePair('commands', '.claude/commands/x.md'),
    ];
    const { observed, resolved } = snapshots(
      pairs.map((p) => p.observed),
      pairs.map((p) => p.resolved),
    );

    const result = classify(observed, resolved);

    expect(facetsOf('.claude/commands/x.md', result)).toEqual(['actions']);
  });
});
