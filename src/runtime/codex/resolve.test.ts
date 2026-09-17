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
import { resolveCodex } from './resolve.js';

const rid = runtimeId('codex');

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
    id: elementIdFor({ runtimeId: rid, origin, path }),
    native: { kind, origin, scope: origin === 'builtin' ? null : origin },
    source: { path },
    inspectability: kind === 'runtime-provided-instructions' ? 'opaque' : 'observable',
    metadata: options.metadata ?? {},
    status: options.status ?? 'observed',
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
  };
}

function snapshot(elements: ObservedElement[]): ObservedSnapshot {
  return {
    schemaVersion: '1',
    snapshotId: generateObservedSnapshotId(),
    capturedAt: '2026-09-16T00:00:00.000Z',
    project: { id: 'proj', displayName: 'owner/repo', root: '/repo' },
    runtime: { id: rid, version: '0.154.0' },
    adapter: { id: 'codex', version: '0.1.0', runtimeCompatibility: 'verified' },
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

describe('resolveCodex', () => {
  it('accumulates project and user instructions as effective', async () => {
    const project = element('AGENTS.md', 'instructions', 'project');
    const user = element('~/.codex/AGENTS.md', 'instructions', 'user');

    const resolved = await resolveCodex(snapshot([project, user]));

    expect(find(resolved.elements, project)).toMatchObject({
      status: 'effective',
      applicability: { type: 'project' },
      resolution: { strategy: 'accumulate' },
    });
    expect(find(resolved.elements, user).applicability).toEqual({ type: 'global' });
  });

  it('lets AGENTS.override.md shadow the base AGENTS.md', async () => {
    const base = element('AGENTS.md', 'instructions', 'project');
    const override = element('AGENTS.override.md', 'fallback-instructions', 'project');

    const resolved = await resolveCodex(snapshot([base, override]));

    expect(find(resolved.elements, override)).toMatchObject({
      status: 'effective',
      resolution: { strategy: 'override' },
    });
    const shadowed = find(resolved.elements, base);
    expect(shadowed.status).toBe('shadowed');
    expect(shadowed.resolution.reason).toContain(override.id);
    expect(resolved.relations).toContainEqual({
      type: 'overrides',
      from: override.id,
      to: base.id,
    });
    expect(resolved.relations).toContainEqual({
      type: 'shadows',
      from: override.id,
      to: base.id,
    });
  });

  it('only shadows the base in the same directory as the override', async () => {
    const rootBase = element('AGENTS.md', 'instructions', 'project');
    const override = element('AGENTS.override.md', 'fallback-instructions', 'project');
    const nestedBase = element('docs/AGENTS.md', 'instructions', 'project');

    const resolved = await resolveCodex(snapshot([rootBase, override, nestedBase]));

    expect(find(resolved.elements, rootBase).status).toBe('shadowed');
    expect(find(resolved.elements, nestedBase).status).toBe('effective');
  });

  it('does not shadow a base in a different directory from the override', async () => {
    const rootBase = element('AGENTS.md', 'instructions', 'project');
    const nestedBase = element('docs/AGENTS.md', 'instructions', 'project');
    // An override in the parent directory and one in a nested directory: neither
    // is beside the root base, so neither may shadow it. Removing the dirname
    // guard would shadow the root base from the parent override.
    const parentOverride = element('../AGENTS.override.md', 'fallback-instructions', 'project');
    const nestedOverride = element('docs/AGENTS.override.md', 'fallback-instructions', 'project');

    const resolved = await resolveCodex(
      snapshot([rootBase, nestedBase, parentOverride, nestedOverride]),
    );

    expect(find(resolved.elements, rootBase).status).toBe('effective');
    expect(find(resolved.elements, nestedBase).status).toBe('shadowed');
    expect(resolved.relations).not.toContainEqual({
      type: 'shadows',
      from: parentOverride.id,
      to: rootBase.id,
    });
  });

  it('derives instruction applicability from the file directory', async () => {
    const root = element('AGENTS.md', 'instructions', 'project');
    const nested = element('docs/AGENTS.md', 'instructions', 'project');
    const deeper = element('docs/api/AGENTS.md', 'instructions', 'project');
    const parent = element('../AGENTS.md', 'instructions', 'project');
    const farParent = element('../../AGENTS.md', 'instructions', 'project');
    const user = element('~/.codex/AGENTS.md', 'instructions', 'user');
    const nestedOverride = element('docs/AGENTS.override.md', 'fallback-instructions', 'project');

    const resolved = await resolveCodex(
      snapshot([root, nested, deeper, parent, farParent, user, nestedOverride]),
    );

    expect(find(resolved.elements, root).applicability).toEqual({ type: 'project' });
    expect(find(resolved.elements, nested).applicability).toEqual({
      type: 'directory-subtree',
      target: 'docs',
    });
    expect(find(resolved.elements, deeper).applicability).toEqual({
      type: 'directory-subtree',
      target: 'docs/api',
    });
    expect(find(resolved.elements, parent).applicability).toEqual({ type: 'global' });
    expect(find(resolved.elements, farParent).applicability).toEqual({ type: 'global' });
    expect(find(resolved.elements, user).applicability).toEqual({ type: 'global' });
    expect(find(resolved.elements, nestedOverride).applicability).toEqual({
      type: 'directory-subtree',
      target: 'docs',
    });
  });

  it('treats on-demand skills and plugins as effective', async () => {
    const skill = element('~/.codex/skills/SKILL.md', 'skills', 'user');
    const plugin = element('~/.codex/config.toml#plugins', 'plugin', 'user');

    const resolved = await resolveCodex(snapshot([skill, plugin]));

    expect(find(resolved.elements, skill)).toMatchObject({
      status: 'effective',
      activation: 'on-demand',
    });
    expect(find(resolved.elements, plugin)).toMatchObject({
      status: 'effective',
      activation: 'on-demand',
      resolution: { strategy: 'available' },
    });
  });

  it('resolves shell environment and project configuration as policy', async () => {
    const shell = element(
      '~/.codex/config.toml#shell_environment_policy',
      'shell-environment',
      'user',
    );
    const project = element('~/.codex/config.toml#projects./repo', 'project-configuration', 'user');

    const resolved = await resolveCodex(snapshot([shell, project]));

    expect(find(resolved.elements, shell)).toMatchObject({
      status: 'effective',
      resolution: { strategy: 'policy' },
    });
    expect(find(resolved.elements, project)).toMatchObject({
      status: 'effective',
      applicability: { type: 'project' },
      resolution: { strategy: 'policy' },
    });
  });

  it('resolves approval/sandbox and compaction controls as policy', async () => {
    const approval = element('~/.codex/config.toml#approval', 'approval-sandbox', 'user');
    const context = element('~/.codex/config.toml#context', 'compaction-controls', 'user');

    const resolved = await resolveCodex(snapshot([approval, context]));

    expect(find(resolved.elements, approval)).toMatchObject({
      status: 'effective',
      resolution: { strategy: 'policy' },
    });
    expect(find(resolved.elements, context).status).toBe('effective');
  });

  it('resolves model configuration as policy and user rules as accumulated', async () => {
    const model = element('~/.codex/config.toml#model', 'model-configuration', 'user');
    const rules = element('~/.codex/rules/default.rules', 'rules', 'user');

    const resolved = await resolveCodex(snapshot([model, rules]));

    expect(find(resolved.elements, model)).toMatchObject({
      status: 'effective',
      applicability: { type: 'global' },
      resolution: { strategy: 'policy' },
    });
    expect(find(resolved.elements, rules)).toMatchObject({
      status: 'effective',
      applicability: { type: 'global' },
      resolution: { strategy: 'accumulate' },
    });
  });

  it('resolves hooks as an event pipeline with the event as target', async () => {
    const hooks = element('~/.codex/hooks.json#hooks', 'hooks', 'user', {
      metadata: { eventNames: ['SessionStart'] },
    });

    const resolved = await resolveCodex(snapshot([hooks]));
    const entry = find(resolved.elements, hooks);

    expect(entry.status).toBe('effective');
    expect(entry.applicability).toEqual({ type: 'tool-event', target: 'SessionStart' });
  });

  it('keeps the opaque builtin layer effective and records a skipped element as unresolved', async () => {
    const opaque = element(
      '(builtin) codex instruction layers',
      'runtime-provided-instructions',
      'builtin',
    );
    const link = element('~/.codex/skills/link', 'skills', 'user', {
      status: 'skipped',
      reason: 'symlink-not-followed',
    });

    const resolved = await resolveCodex(snapshot([opaque, link]));

    expect(find(resolved.elements, opaque).status).toBe('effective');
    expect(find(resolved.elements, link).status).toBe('unresolved');
  });
});
