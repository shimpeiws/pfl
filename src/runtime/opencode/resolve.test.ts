import { describe, expect, it } from 'vitest';
import { elementIdFor, generateObservedSnapshotId, runtimeId } from '../../core/ids.js';
import type {
  NativeOrigin,
  ObservedElement,
  ObservedReason,
  ObservedSnapshot,
  ObservedStatus,
  SafeMetadataValue,
} from '../../core/observed.js';
import type { ResolvedElement } from '../../core/resolved.js';
import { resolveOpencode, semanticsFor } from './resolve.js';

const rid = runtimeId('opencode');

function element(
  path: string,
  kind: string,
  origin: NativeOrigin,
  options: {
    status?: ObservedStatus;
    reason?: ObservedReason;
    metadata?: Record<string, SafeMetadataValue>;
  } = {},
): ObservedElement {
  return {
    id: elementIdFor({ runtimeId: rid, origin, path, kind }),
    native: { kind, origin, scope: origin === 'builtin' ? null : origin },
    source: { path },
    inspectability: kind === 'runtime-provided-instructions' ? 'opaque' : 'observable',
    metadata: options.metadata ?? {},
    status: options.status ?? 'observed',
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
  };
}

function snapshot(
  elements: ObservedElement[],
  version: string | null = '1.18.31',
): ObservedSnapshot {
  return {
    schemaVersion: '1',
    snapshotId: generateObservedSnapshotId(),
    capturedAt: '2026-09-18T00:00:00.000Z',
    project: { id: 'proj', displayName: 'owner/repo', root: '/repo' },
    runtime: { id: rid, version },
    adapter: { id: 'opencode', version: '0.1.0', runtimeCompatibility: 'verified' },
    elements,
    diagnostics: [],
    completeness: 'complete',
    digests: { observed: 'sha256:x' },
  };
}

function find(resolved: ResolvedElement[], source: ObservedElement): ResolvedElement {
  const found = resolved.find((entry) => entry.id === source.id);
  if (found === undefined) throw new Error('expected a resolved element');
  return found;
}

describe('semanticsFor', () => {
  it('treats only a member of the verified set as within', () => {
    expect(semanticsFor('1.18.31').position).toBe('within');
    expect(semanticsFor('1.18.30').position).toBe('within');
    expect(semanticsFor('1.18.0').position).toBe('within');
    expect(semanticsFor('1.18.15').position).toBe('unknown');
    expect(semanticsFor('1.17.0').position).toBe('below');
    expect(semanticsFor('1.19.0').position).toBe('above');
    expect(semanticsFor(null).position).toBe('unknown');
  });
});

describe('resolveOpencode', () => {
  it('derives instruction applicability from the file location', async () => {
    const root = element('AGENTS.md', 'instructions', 'project');
    const nested = element('docs/AGENTS.md', 'instructions', 'project');
    const parent = element('../AGENTS.md', 'instructions', 'project');
    const user = element('~/.config/opencode/AGENTS.md', 'instructions', 'user');

    const resolved = await resolveOpencode(snapshot([root, nested, parent, user]));

    expect(find(resolved.elements, root)).toMatchObject({
      applicability: { type: 'project' },
      resolution: { strategy: 'accumulate' },
    });
    expect(find(resolved.elements, nested).applicability).toEqual({
      type: 'directory-subtree',
      target: 'docs',
    });
    expect(find(resolved.elements, parent).applicability).toEqual({ type: 'global' });
    expect(find(resolved.elements, user).applicability).toEqual({ type: 'global' });
  });

  it('resolves on-demand catalog kinds as available', async () => {
    const skills = element('.opencode/skill/x/SKILL.md', 'skills', 'project');
    const commands = element('.opencode/command/x.md', 'commands', 'project');
    const subagents = element('.opencode/agent/x.md', 'subagents', 'project');
    const agents = element('.opencode/agent/y.md', 'agents', 'project');
    const plugin = element('.opencode/plugin/x.ts', 'plugin', 'project');

    const resolved = await resolveOpencode(snapshot([skills, commands, subagents, agents, plugin]));

    for (const source of [skills, commands, subagents, agents, plugin]) {
      expect(find(resolved.elements, source)).toMatchObject({
        status: 'effective',
        applicability: { type: 'project' },
        activation: 'on-demand',
        resolution: { strategy: 'available' },
      });
    }
  });

  it('resolves policy kinds and the project configuration', async () => {
    const permissions = element('opencode.json#permission', 'permissions', 'project');
    const project = element('.opencode/opencode.json#project', 'project-configuration', 'project');
    const model = element('~/.config/opencode/opencode.json#model', 'model-configuration', 'user');

    const resolved = await resolveOpencode(snapshot([permissions, project, model]));

    expect(find(resolved.elements, permissions)).toMatchObject({
      applicability: { type: 'config-rule' },
      resolution: { strategy: 'policy' },
      activation: 'always',
    });
    expect(find(resolved.elements, project)).toMatchObject({
      applicability: { type: 'project' },
      resolution: { strategy: 'policy' },
    });
    expect(find(resolved.elements, model)).toMatchObject({
      applicability: { type: 'global' },
      resolution: { strategy: 'policy' },
    });
  });

  it('records a declared reference as an opaque config rule', async () => {
    const reference = element('opencode.json#references.0', 'references', 'project');

    const resolved = await resolveOpencode(snapshot([reference]));

    expect(find(resolved.elements, reference)).toMatchObject({
      applicability: { type: 'config-rule' },
      resolution: { strategy: 'available' },
      activation: 'on-demand',
    });
  });

  it('resolves a declared instruction target like a reference, not an instruction file', async () => {
    // An `instructions` array entry is opaque: it is a declaration, not an
    // observed file. It must not accumulate as an effective instruction.
    const declared = {
      ...element('opencode.json#instructions.0', 'instructions', 'project'),
      inspectability: 'opaque' as const,
    };

    const resolved = await resolveOpencode(snapshot([declared]));

    expect(find(resolved.elements, declared)).toMatchObject({
      applicability: { type: 'config-rule' },
      resolution: { strategy: 'available' },
      activation: 'on-demand',
    });
  });

  it('records the opaque layers as runtime-defined and never blocks a newer version', async () => {
    const builtin = element(
      '(builtin) opencode instruction layers',
      'runtime-provided-instructions',
      'builtin',
    );

    const resolved = await resolveOpencode(snapshot([builtin], '1.19.0'));

    expect(find(resolved.elements, builtin)).toMatchObject({
      applicability: { type: 'runtime-defined' },
      resolution: { strategy: 'runtime-defined' },
      status: 'effective',
    });
    // A version outside the verified set is best-effort, not a failure.
    expect(resolved.resolution.confidence).toBe('unverified-runtime-version');
  });

  it('leaves an unreadable element unresolved', async () => {
    const unreadable = element('opencode.json', 'config', 'user', {
      status: 'unreadable',
      reason: 'unreadable',
    });

    const resolved = await resolveOpencode(snapshot([unreadable]));

    expect(find(resolved.elements, unreadable)).toMatchObject({
      applicability: { type: 'unknown' },
      resolution: { strategy: 'unknown' },
      activation: 'unknown',
      status: 'unresolved',
    });
  });
});
