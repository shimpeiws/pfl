import { describe, expect, it } from 'vitest';
import { elementIdFor, runtimeId } from '../core/ids.js';
import type { ObservedElement } from '../core/observed.js';
import { harnessContentDigest, resolvedSnapshotDigest } from './digest.js';

function element(id: string, inspectability: ObservedElement['inspectability']): ObservedElement {
  return {
    id: elementIdFor({
      runtimeId: runtimeId('claude-code'),
      origin: 'project',
      path: `${id}.md`,
      kind: 'instructions',
    }),
    native: { kind: 'instructions', origin: 'project', scope: null },
    source: { path: `${id}.md` },
    inspectability,
    metadata: {},
    status: 'observed',
  };
}

describe('harnessContentDigest', () => {
  it('does not depend on element discovery order', () => {
    const a = harnessContentDigest([element('a', 'observable'), element('b', 'observable')]);
    const b = harnessContentDigest([element('b', 'observable'), element('a', 'observable')]);
    expect(a).toBe(b);
  });

  it('excludes opaque runtime-provided layers', () => {
    const withOpaque = harnessContentDigest([element('a', 'observable'), element('b', 'opaque')]);
    const withoutOpaque = harnessContentDigest([element('a', 'observable')]);
    expect(withOpaque).toBe(withoutOpaque);
  });
});

describe('resolvedSnapshotDigest', () => {
  it('changes when the runtime version changes', () => {
    const base = {
      harnessContentDigest: 'sha256:abc',
      runtimeId: 'claude-code',
      semanticsVersion: '1',
    };
    const older = resolvedSnapshotDigest({ ...base, runtimeVersion: '1.7.0' });
    const newer = resolvedSnapshotDigest({ ...base, runtimeVersion: '1.8.0' });
    expect(older).not.toBe(newer);
  });
});
