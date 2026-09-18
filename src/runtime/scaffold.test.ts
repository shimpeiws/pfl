import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '../core/diagnostics.js';
import type { ObservedElement } from '../core/observed.js';
import { runtimeId } from '../core/ids.js';
import type { DiscoveredPath } from '../discovery/walk.js';
import { createElementBuilders, pushWalkedEntry } from './scaffold.js';

/**
 * The shared walked-entry decision (roadmap M9 #90). The branch order matters:
 * an unknown-*kind* item is checked after the non-regular entry case, so a
 * non-regular entry whose kind is unknown is reported as skipped rather than
 * unsupported. That order is invisible to the adapter suites, so it is pinned
 * here; swapping the two branches turns this test red.
 */

type TestKind = 'instructions' | 'unknown';
const builders = createElementBuilders<TestKind>(runtimeId('test'));

function entry(overrides: Partial<DiscoveredPath>): DiscoveredPath {
  return { relativePath: 'x', kind: 'file', digest: 'sha256:x', ...overrides };
}

function run(
  e: DiscoveredPath,
  unsupported: boolean,
): { elements: ObservedElement[]; diagnostics: Diagnostic[] } {
  const elements: ObservedElement[] = [];
  const diagnostics: Diagnostic[] = [];
  pushWalkedEntry({
    runtimeId: runtimeId('test'),
    builders,
    entry: e,
    origin: 'project',
    scope: 'project',
    kind: 'instructions',
    displayPath: 'x',
    metadataForPath: () => ({}),
    elements,
    diagnostics,
    unsupported,
  });
  return { elements, diagnostics };
}

describe('pushWalkedEntry', () => {
  it('records a non-regular entry as skipped even when its kind is unknown', () => {
    // The order guard: entry.kind === 'unknown' is checked before `unsupported`.
    const { elements } = run(entry({ kind: 'unknown' }), true);

    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({
      status: 'skipped',
      reason: 'non-regular-file-not-opened',
    });
  });

  it('records an unclassified regular file as unsupported when asked', () => {
    const { elements } = run(entry({}), true);

    expect(elements[0]).toMatchObject({ status: 'unsupported', reason: 'unsupported-by-adapter' });
  });

  it('records a symlink, a refused hardlink, and an over-limit file with their reasons', () => {
    expect(run(entry({ kind: 'symlink' }), false).elements[0]).toMatchObject({
      status: 'skipped',
      reason: 'symlink-not-followed',
    });
    expect(run(entry({ skipReason: 'hardlink-not-followed' }), false).elements[0]).toMatchObject({
      status: 'skipped',
      reason: 'hardlink-not-followed',
    });
    expect(run(entry({ skipReason: 'file-too-large' }), false).elements[0]).toMatchObject({
      status: 'skipped',
      reason: 'limit-exceeded',
    });
  });

  it('records an unreadable regular file as unreadable with a diagnostic', () => {
    const { elements, diagnostics } = run({ relativePath: 'x', kind: 'file' }, false);

    expect(elements[0]).toMatchObject({ status: 'unreadable', reason: 'unreadable' });
    expect(diagnostics.map((d) => d.code)).toContain('unreadable-file');
  });
});
