import { describe, expect, it } from 'vitest';
import {
  elementIdFor,
  generateObservedSnapshotId,
  runtimeId,
  type ResolvedSnapshotId,
} from '../core/ids.js';
import type { ObservedSnapshot } from '../core/observed.js';
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

  it('downgrades confidence and warns on an unverified version without blocking', () => {
    const resolved = assembleResolvedSnapshot({
      observed: observedSnapshot('unverified', null),
      elements: [resolvedElement('a', 'effective')],
    });

    expect(resolved.resolution.confidence).toBe('unverified-runtime-version');
    expect(resolved.diagnostics.map((entry) => entry.code)).toContain('runtime-version-unverified');
    expect(resolved.effectiveElementIds).toHaveLength(1);
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
