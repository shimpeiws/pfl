import { describe, expect, it } from 'vitest';
import {
  elementIdFor,
  generateObservedSnapshotId,
  runtimeId,
  type ResolvedSnapshotId,
} from '../core/ids.js';
import type { Finding } from '../core/interpretation.js';
import type {
  NativeOrigin,
  ObservedElement,
  ObservedSnapshot,
  SafeMetadataValue,
} from '../core/observed.js';
import type {
  Applicability,
  ResolvedElement,
  ResolvedSnapshot,
  ResolvedStatus,
} from '../core/resolved.js';
import {
  BROAD_TOOL_ACCESS_MIN_ALLOW,
  CONDITIONAL_HEAVY_MIN_COUNT,
  deriveFindings,
} from './findings.js';

const rid = runtimeId('claude-code');

interface Options {
  origin?: NativeOrigin;
  inspectability?: ObservedElement['inspectability'];
  metadata?: Record<string, SafeMetadataValue>;
  resolvedStatus?: ResolvedStatus;
  applicability?: Applicability;
}

function makePair(kind: string, path: string, options: Options = {}) {
  const origin = options.origin ?? 'project';
  const id = elementIdFor({ runtimeId: rid, origin, path });
  const observed: ObservedElement = {
    id,
    native: { kind, origin, scope: origin },
    source: { path },
    inspectability: options.inspectability ?? 'observable',
    metadata: options.metadata ?? {},
    status: 'observed',
  };
  const resolved: ResolvedElement = {
    id,
    status: options.resolvedStatus ?? 'effective',
    applicability: options.applicability ?? { type: 'project' },
    activation: 'always',
    resolution: { strategy: 'accumulate', reason: 'test' },
  };
  return { observed, resolved };
}

function snapshots(pairs: ReturnType<typeof makePair>[]): {
  observed: ObservedSnapshot;
  resolved: ResolvedSnapshot;
} {
  const observed: ObservedSnapshot = {
    schemaVersion: '1',
    snapshotId: generateObservedSnapshotId(),
    capturedAt: '2026-09-16T00:00:00.000Z',
    project: { id: 'proj', displayName: 'owner/repo', root: '/repo' },
    runtime: { id: rid, version: '2.1.272' },
    adapter: { id: 'claude-code', version: '0.1.0', runtimeCompatibility: 'verified' },
    elements: pairs.map((pair) => pair.observed),
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
    elements: pairs.map((pair) => pair.resolved),
    relations: [],
    effectiveElementIds: [],
    diagnostics: [],
    digests: { harnessContent: 'sha256:h', resolvedSnapshot: 'sha256:r' },
  };
  return { observed, resolved };
}

function rules(findings: Finding[]): string[] {
  return findings.map((finding) => finding.rule);
}

describe('deriveFindings', () => {
  it('reports a shadowed element', () => {
    const shadowed = makePair('permissions', '.claude/settings.json#permissions', {
      resolvedStatus: 'shadowed',
    });

    const { observed, resolved } = snapshots([shadowed]);
    const findings = deriveFindings(observed, resolved);

    expect(rules(findings)).toContain('shadowed-element');
    expect(findings.find((f) => f.rule === 'shadowed-element')?.elementIds).toEqual([
      shadowed.observed.id,
    ]);
  });

  it('reports a settings key defined at more than one scope', () => {
    const project = makePair('permissions', '.claude/settings.json#permissions');
    const user = makePair('permissions', '~/.claude/settings.json#permissions', { origin: 'user' });

    const { observed, resolved } = snapshots([project, user]);
    const findings = deriveFindings(observed, resolved);

    expect(rules(findings)).toContain('conflicting-scope');
  });

  it('reports opaque runtime layers', () => {
    const opaque = makePair('runtime-provided-instructions', '(builtin) layers', {
      origin: 'builtin',
      inspectability: 'opaque',
    });

    const { observed, resolved } = snapshots([opaque]);
    const findings = deriveFindings(observed, resolved);

    expect(rules(findings)).toContain('opaque-runtime-layer');
  });

  it('reports a broad tool allow-list at or above the threshold', () => {
    const wide = makePair('permissions', '.claude/settings.json#permissions', {
      metadata: { allowCount: BROAD_TOOL_ACCESS_MIN_ALLOW },
    });
    const narrow = makePair('permissions', '.claude/settings.local.json#permissions', {
      metadata: { allowCount: BROAD_TOOL_ACCESS_MIN_ALLOW - 1 },
    });

    const { observed, resolved } = snapshots([wide]);
    expect(rules(deriveFindings(observed, resolved))).toContain('broad-tool-access');

    const narrowSnapshots = snapshots([narrow]);
    expect(rules(deriveFindings(narrowSnapshots.observed, narrowSnapshots.resolved))).not.toContain(
      'broad-tool-access',
    );
  });

  it('reports conditional-heavy only past the count and ratio thresholds', () => {
    const heavy = Array.from({ length: 6 }, (_, i) =>
      makePair('skills', `.claude/skills/s${i}/SKILL.md`, { resolvedStatus: 'conditional' }),
    );
    const lightEffective = Array.from({ length: 4 }, (_, i) =>
      makePair('skills', `.claude/skills/e${i}/SKILL.md`),
    );
    const heavySnapshots = snapshots([...heavy, ...lightEffective]);
    expect(rules(deriveFindings(heavySnapshots.observed, heavySnapshots.resolved))).toContain(
      'conditional-heavy',
    );

    // Below the absolute count, even at a high ratio.
    const few = Array.from({ length: CONDITIONAL_HEAVY_MIN_COUNT - 1 }, (_, i) =>
      makePair('skills', `.claude/skills/f${i}/SKILL.md`, { resolvedStatus: 'conditional' }),
    );
    const fewSnapshots = snapshots(few);
    expect(rules(deriveFindings(fewSnapshots.observed, fewSnapshots.resolved))).not.toContain(
      'conditional-heavy',
    );
  });

  it('reports memory, subtree instructions, all descriptively', () => {
    const memory = makePair('memory', '~/.claude/projects/x/memory/MEMORY.md', { origin: 'user' });
    const subtree = makePair('instructions', 'docs/CLAUDE.md', {
      applicability: { type: 'directory-subtree', target: 'docs' },
    });

    const { observed, resolved } = snapshots([memory, subtree]);
    const findings = deriveFindings(observed, resolved);

    expect(rules(findings)).toContain('memory-enabled');
    expect(rules(findings)).toContain('subtree-specific-instruction');
  });

  it('never uses evaluative vocabulary', () => {
    const pairs = [
      makePair('permissions', '.claude/settings.json#permissions', {
        resolvedStatus: 'shadowed',
        metadata: { allowCount: 20 },
      }),
      makePair('permissions', '~/.claude/settings.json#permissions', { origin: 'user' }),
      makePair('runtime-provided-instructions', '(builtin) layers', {
        origin: 'builtin',
        inspectability: 'opaque',
      }),
      makePair('memory', '~/.claude/projects/x/memory/MEMORY.md', { origin: 'user' }),
    ];

    const { observed, resolved } = snapshots(pairs);
    const messages = deriveFindings(observed, resolved)
      .map((finding) => finding.message)
      .join('\n');

    expect(messages).not.toMatch(/\b(good|bad|better|worse|recommended|roi)\b/i);
  });
});
