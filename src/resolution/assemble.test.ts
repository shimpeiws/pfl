import { describe, expect, it } from 'vitest';
import {
  elementIdFor,
  generateObservedSnapshotId,
  runtimeId,
  type ResolvedSnapshotId,
} from '../core/ids.js';
import type { ObservedElement, ObservedSnapshot } from '../core/observed.js';
import type { ResolvedElement, ResolvedStatus } from '../core/resolved.js';
import { harnessContentDigest } from '../snapshot/digest.js';
import { RESOLUTION_SEMANTICS_VERSION, assembleResolvedSnapshot } from './assemble.js';

function resolvedElement(path: string, status: ResolvedStatus): ResolvedElement {
  return {
    id: elementIdFor({ runtimeId: runtimeId('claude-code'), origin: 'project', path }),
    status,
    applicability: { type: 'project' },
    activation: 'always',
    resolution: { strategy: 'accumulate', reason: 'test' },
  };
}

function observedElement(path: string, kind: string): ObservedElement {
  const origin = path.startsWith('~/') ? 'user' : 'project';
  return {
    id: elementIdFor({ runtimeId: runtimeId('claude-code'), origin, path }),
    native: { kind, origin, scope: origin },
    source: { path },
    inspectability: 'observable',
    metadata: {},
    status: 'observed',
  };
}

function observedSnapshot(
  runtimeCompatibility: 'verified' | 'unverified' = 'verified',
  version: string | null = '2.1.100',
): ObservedSnapshot {
  return {
    schemaVersion: '1',
    snapshotId: generateObservedSnapshotId(),
    capturedAt: '2026-09-16T00:00:00.000Z',
    project: { id: 'proj', displayName: 'owner/repo', root: '/repo' },
    runtime: { id: runtimeId('claude-code'), version },
    adapter: { id: 'claude-code', version: '0.1.0', runtimeCompatibility },
    elements: [],
    diagnostics: [],
    completeness: 'complete',
    digests: { observed: 'sha256:abc' },
  };
}

describe('assembleResolvedSnapshot', () => {
  it('references the observed snapshot and collects the effective set', () => {
    const observed = observedSnapshot();
    const elements = [
      resolvedElement('a', 'effective'),
      resolvedElement('b', 'shadowed'),
      resolvedElement('c', 'effective'),
    ];

    const resolved = assembleResolvedSnapshot({
      observed,
      elements,
      snapshotId: 'res_test' as ResolvedSnapshotId,
    });

    expect(resolved.schemaVersion).toBe('1');
    expect(resolved.snapshotId).toBe('res_test');
    expect(resolved.observedSnapshotId).toBe(observed.snapshotId);
    expect(resolved.effectiveElementIds).toEqual([elements[0]?.id, elements[2]?.id]);
    expect(resolved.resolution.semanticsVersion).toBe(RESOLUTION_SEMANTICS_VERSION);
    expect(resolved.digests.harnessContent).toBe(harnessContentDigest(observed.elements));
  });

  it('redacts resolved diagnostics at persistence', () => {
    const home = '/Users/alice';
    const resolved = assembleResolvedSnapshot({
      observed: observedSnapshot(),
      elements: [],
      home,
      diagnostics: [
        {
          severity: 'warning',
          code: 'example',
          message: `could not read ${home}/project/sess-abcdefghijklmnop`,
          path: `${home}/project/file`,
        },
      ],
    });

    expect(resolved.diagnostics[0]?.path).toBe('~/project/file');
    expect(resolved.diagnostics[0]?.message).not.toContain(home);
    expect(resolved.diagnostics[0]?.message).not.toContain('sess-abcdefghijklmnop');
  });

  it('downgrades confidence and warns on an unverified version without blocking', () => {
    const resolved = assembleResolvedSnapshot({
      observed: observedSnapshot('unverified', null),
      elements: [resolvedElement('a', 'effective')],
    });

    expect(resolved.resolution.confidence).toBe('unverified-runtime-version');
    expect(resolved.diagnostics.map((entry) => entry.code)).toContain('runtime-version-unverified');
    expect(resolved.effectiveElementIds).toHaveLength(1);
  });

  it('derives accumulates-with edges for accumulating layers', () => {
    const project = observedElement('CLAUDE.md', 'instructions');
    const user = observedElement('~/.claude/CLAUDE.md', 'instructions');
    const observed = { ...observedSnapshot(), elements: [project, user] };

    const resolved = assembleResolvedSnapshot({
      observed,
      elements: [project, user].map((element) => ({
        id: element.id,
        status: 'effective',
        applicability: { type: 'project' },
        activation: 'always',
        resolution: { strategy: 'accumulate' },
      })),
    });

    expect(resolved.relations).toContainEqual({
      type: 'accumulates-with',
      from: project.id,
      to: user.id,
    });
  });

  it('keeps the content digest while the resolved digest changes with the runtime version', () => {
    const elements = [observedElement('CLAUDE.md', 'instructions')];
    const older = assembleResolvedSnapshot({
      observed: {
        ...observedSnapshot(),
        elements,
        runtime: { id: runtimeId('claude-code'), version: '0.150.0' },
      },
      elements: [],
    });
    const newer = assembleResolvedSnapshot({
      observed: {
        ...observedSnapshot(),
        elements,
        runtime: { id: runtimeId('claude-code'), version: '0.154.0' },
      },
      elements: [],
    });

    expect(older.digests.harnessContent).toBe(newer.digests.harnessContent);
    expect(older.digests.resolvedSnapshot).not.toBe(newer.digests.resolvedSnapshot);
  });

  it('keeps a verified version at full confidence', () => {
    const resolved = assembleResolvedSnapshot({
      observed: observedSnapshot('verified'),
      elements: [resolvedElement('a', 'effective')],
    });

    expect(resolved.resolution.confidence).toBe('verified');
    expect(resolved.diagnostics).toEqual([]);
  });
});
