import { describe, expect, it } from 'vitest';
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
});
