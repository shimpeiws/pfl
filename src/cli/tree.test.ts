import { describe, expect, it } from 'vitest';
import type { HarnessFacet } from '../core/facets.js';
import type { GraphModel } from './graph-model.js';
import { detectTreeStyle, renderGraph } from './tree.js';

const model: GraphModel = {
  observedSnapshotId: 'obs_x',
  resolvedSnapshotId: 'res_x',
  nodes: [
    {
      id: 'el_a',
      path: 'CLAUDE.md',
      kind: 'instructions',
      origin: 'project',
      scope: 'project',
      status: 'effective',
      inspectability: 'observable',
      facets: ['instructions'],
    },
    {
      id: 'el_b',
      path: '(builtin) layers',
      kind: 'runtime-provided-instructions',
      origin: 'builtin',
      scope: null,
      status: 'effective',
      inspectability: 'opaque',
      facets: ['instructions'],
    },
  ],
  edges: [],
};

describe('detectTreeStyle', () => {
  it('prefers UTF-8 and falls back to ASCII', () => {
    expect(detectTreeStyle({ LANG: 'en_US.UTF-8' }).branch).toBe('├─ ');
    expect(detectTreeStyle({ LANG: 'C' }).branch).toBe('+- ');
    expect(detectTreeStyle({ LANG: 'en_US.utf8' }).branch).toBe('├─ ');
  });
});

describe('renderGraph', () => {
  it('marks opaque nodes and renders effective facets', () => {
    const lines = renderGraph(model, { branch: '+- ', last: '`- ', pipe: '|  ', space: '   ' });

    const output = lines.join('\n');
    expect(output).toContain('effective');
    expect(output).toContain('`- instructions');
    expect(output).toContain('(builtin) layers (opaque)');
    expect(output).not.toContain('├─');
  });

  it('marks an opaque node in the effective section too', () => {
    const lines = renderGraph(model);

    expect(lines.filter((line) => line.includes('(opaque)'))).toHaveLength(2);
  });

  it('renders a multi-facet element once, with its facets inline (#161)', () => {
    const multi: GraphModel = {
      observedSnapshotId: 'obs_x',
      resolvedSnapshotId: 'res_x',
      nodes: [
        {
          id: 'el_multi',
          path: '~/.claude/skills/x/SKILL.md',
          kind: 'skills',
          origin: 'user',
          scope: 'user',
          status: 'effective',
          inspectability: 'observable',
          facets: ['knowledge', 'actions'],
        },
      ],
      edges: [],
    };

    const output = renderGraph(multi).join('\n');

    const appearances = output
      .split('\n')
      .filter((line) => line.includes('~/.claude/skills/x/SKILL.md'));
    expect(appearances).toHaveLength(2); // once in `user` sources, once in `effective`
    expect(output).toContain('[knowledge, actions]');
    // It groups under its primary facet only — no `actions` group header.
    const lines = output.split('\n');
    expect(lines.some((line) => /─ actions$/.test(line))).toBe(false);
  });

  it('groups by the first recognized facet and falls back for unknown ones (#161)', () => {
    // Stored interpretations tolerate facets a newer classifier added; such a
    // node must still appear in the effective section.
    const future: GraphModel = {
      observedSnapshotId: 'obs_x',
      resolvedSnapshotId: 'res_x',
      nodes: [
        {
          id: 'el_future',
          path: 'a.md',
          kind: 'instructions',
          origin: 'project',
          scope: 'project',
          status: 'effective',
          inspectability: 'observable',
          facets: ['planning' as HarnessFacet, 'actions'],
        },
        {
          id: 'el_alien',
          path: 'b.md',
          kind: 'instructions',
          origin: 'project',
          scope: 'project',
          status: 'effective',
          inspectability: 'observable',
          facets: ['planning' as HarnessFacet],
        },
      ],
      edges: [],
    };

    const output = renderGraph(future).join('\n');

    // 'planning' is unknown to this binary: el_future groups under 'actions',
    // its first recognized facet; el_alien lands in the fallback group.
    expect(output).toMatch(/─ actions\n/);
    expect(output).toContain('a.md  [planning, actions]');
    expect(output).toContain('(unclassified)');
    expect(output).toContain('b.md  [planning]');
  });
});
