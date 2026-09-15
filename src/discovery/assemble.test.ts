import { describe, expect, it } from 'vitest';
import { elementIdFor, runtimeId } from '../core/ids.js';
import type { ObservedElement, ObservedReason, ObservedStatus } from '../core/observed.js';
import { harnessContentDigest } from '../snapshot/digest.js';
import { assembleObservedSnapshot, completenessOf } from './assemble.js';

function element(id: string, status: ObservedStatus, reason?: ObservedReason): ObservedElement {
  return {
    id: elementIdFor({ runtimeId: runtimeId('claude-code'), origin: 'project', path: `${id}.md` }),
    native: { kind: 'instructions', origin: 'project', scope: null },
    source: { path: `${id}.md` },
    inspectability: 'observable',
    metadata: {},
    status,
    ...(reason ? { reason } : {}),
  };
}

function input(
  elements: ObservedElement[],
  diagnostics: Parameters<typeof completenessOf>[1] = [],
) {
  return {
    project: { id: 'proj', displayName: 'owner/repo', root: '/repo' },
    runtime: { id: runtimeId('claude-code'), version: '2.1.272' },
    adapter: { id: 'claude-code', version: '0.1.0', runtimeCompatibility: 'verified' as const },
    elements,
    diagnostics,
    capturedAt: '2026-09-16T00:00:00.000Z',
  };
}

describe('assembleObservedSnapshot', () => {
  it('fills the schemaVersion, id, capturedAt, and the harness content digest', () => {
    const elements = [element('a', 'observed'), element('b', 'observed')];

    const snapshot = assembleObservedSnapshot(input(elements));

    expect(snapshot.schemaVersion).toBe('1');
    expect(snapshot.snapshotId).toMatch(/^obs_[0-9a-f]{12}$/);
    expect(snapshot.capturedAt).toBe('2026-09-16T00:00:00.000Z');
    expect(snapshot.digests.observed).toBe(harnessContentDigest(elements));
    expect(snapshot.completeness).toBe('complete');
  });

  it('preserves a skipped symlink element with its reason', () => {
    const skipped = element('link', 'skipped', 'symlink-not-followed');

    const snapshot = assembleObservedSnapshot(input([skipped]));

    expect(snapshot.elements[0]).toMatchObject({
      status: 'skipped',
      reason: 'symlink-not-followed',
    });
    expect(snapshot.completeness).toBe('partial');
  });

  it('rejects a non-observed element with no reason', () => {
    expect(() => assembleObservedSnapshot(input([element('x', 'skipped')]))).toThrow(
      /status "skipped" but no reason/,
    );
  });

  it('preserves diagnostics order', () => {
    const diagnostics = [
      { severity: 'info' as const, code: 'a', message: 'a' },
      { severity: 'warning' as const, code: 'b', message: 'b' },
    ];

    const snapshot = assembleObservedSnapshot(input([element('a', 'observed')], diagnostics));

    expect(snapshot.diagnostics.map((d) => d.code)).toEqual(['a', 'b']);
  });
});

describe('completenessOf', () => {
  it('is complete only when nothing was missing', () => {
    expect(completenessOf([element('a', 'observed')])).toBe('complete');
  });

  it('is partial when anything was unreadable, unsupported, or skipped', () => {
    expect(
      completenessOf([element('a', 'observed'), element('b', 'unreadable', 'unreadable')]),
    ).toBe('partial');
    expect(
      completenessOf([
        element('a', 'observed'),
        element('b', 'unsupported', 'unsupported-by-adapter'),
      ]),
    ).toBe('partial');
    expect(
      completenessOf([element('a', 'observed'), element('b', 'skipped', 'symlink-not-followed')]),
    ).toBe('partial');
  });

  it('is partial when a warning or error diagnostic was raised', () => {
    expect(
      completenessOf(
        [element('a', 'observed')],
        [{ severity: 'warning', code: 'w', message: 'w' }],
      ),
    ).toBe('partial');
    expect(
      completenessOf([element('a', 'observed')], [{ severity: 'info', code: 'i', message: 'i' }]),
    ).toBe('complete');
  });

  it('is unknown when the only gap is an unclassifiable element', () => {
    expect(completenessOf([element('a', 'observed'), element('b', 'unknown', 'unknown')])).toBe(
      'unknown',
    );
  });
});
