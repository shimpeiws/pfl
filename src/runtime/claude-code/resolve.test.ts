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
import { MARKETPLACE_CATALOG_REASON, resolveClaudeCode, semanticsFor } from './resolve.js';

const rid = runtimeId('claude-code');

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
  const status = options.status ?? 'observed';
  return {
    id: elementIdFor({ runtimeId: rid, origin, path, kind }),
    native: { kind, origin, scope: origin === 'builtin' ? null : origin },
    source: { path },
    inspectability: kind === 'runtime-provided-instructions' ? 'opaque' : 'observable',
    metadata: options.metadata ?? {},
    status,
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
  };
}

function snapshot(
  elements: ObservedElement[],
  version: string | null = '2.1.100',
): ObservedSnapshot {
  return {
    schemaVersion: '1',
    snapshotId: generateObservedSnapshotId(),
    capturedAt: '2026-09-16T00:00:00.000Z',
    project: { id: 'proj', displayName: 'owner/repo', root: '/repo' },
    runtime: { id: rid, version },
    adapter: { id: 'claude-code', version: '0.1.0', runtimeCompatibility: 'verified' },
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

describe('resolveClaudeCode', () => {
  it('accumulates instructions from both scopes as effective', async () => {
    const project = element('CLAUDE.md', 'instructions', 'project');
    const user = element('~/.claude/CLAUDE.md', 'instructions', 'user');

    const resolved = await resolveClaudeCode(snapshot([project, user]));

    expect(find(resolved.elements, project).status).toBe('effective');
    expect(find(resolved.elements, user).status).toBe('effective');
  });

  it('treats an on-demand skill as effective, not conditional', async () => {
    const skill = element('.claude/skills/foo/SKILL.md', 'skills', 'project');

    const resolved = await resolveClaudeCode(snapshot([skill]));

    expect(find(resolved.elements, skill)).toMatchObject({
      status: 'effective',
      activation: 'on-demand',
    });
  });

  it('resolves plugins and plugin-provided elements as effective', async () => {
    const plugin = element('~/.claude/settings.json#enabledPlugins', 'plugin', 'user');
    const manifest = element('~/.claude/plugins/market/plug/plugin.json', 'plugin', 'plugin');
    const skill = element('~/.claude/plugins/market/plug/skills/x/SKILL.md', 'skills', 'plugin');

    const resolved = await resolveClaudeCode(snapshot([plugin, manifest, skill]));

    for (const source of [plugin, manifest]) {
      expect(find(resolved.elements, source)).toMatchObject({
        status: 'effective',
        applicability: { type: 'global' },
        resolution: { strategy: 'available' },
        activation: 'on-demand',
      });
    }
    expect(find(resolved.elements, skill)).toMatchObject({
      status: 'effective',
      resolution: { strategy: 'available' },
    });
  });

  it('resolves marketplace catalog clones as unresolved, keeping installed cache effective (#176)', async () => {
    const catalogSkill = element(
      '~/.claude/plugins/marketplaces/official/hookify/skills/x/SKILL.md',
      'skills',
      'plugin',
    );
    const catalogHook = element(
      '~/.claude/plugins/marketplaces/official/hookify/hooks/pretooluse.py',
      'hooks',
      'plugin',
    );
    const installed = element(
      '~/.claude/plugins/cache/pstack-claude/pstack/0.9.15/commands/go.md',
      'commands',
      'plugin',
    );

    const resolved = await resolveClaudeCode(snapshot([catalogSkill, catalogHook, installed]));

    for (const source of [catalogSkill, catalogHook]) {
      expect(find(resolved.elements, source)).toMatchObject({
        status: 'unresolved',
        resolution: { reason: MARKETPLACE_CATALOG_REASON },
      });
      expect(resolved.effectiveElementIds).not.toContain(source.id);
    }
    expect(find(resolved.elements, installed).status).toBe('effective');
    expect(resolved.effectiveElementIds).toContain(installed.id);
  });

  it('derives instruction applicability from the file directory', async () => {
    const root = element('CLAUDE.md', 'instructions', 'project');
    const nested = element('docs/CLAUDE.md', 'instructions', 'project');
    const deeper = element('docs/api/CLAUDE.md', 'instructions', 'project');
    const parent = element('../CLAUDE.md', 'instructions', 'project');
    const farParent = element('../../CLAUDE.md', 'instructions', 'project');
    const user = element('~/.claude/CLAUDE.md', 'instructions', 'user');
    const managed = element(
      '/Library/Application Support/ClaudeCode/CLAUDE.md',
      'instructions',
      'managed',
    );

    const resolved = await resolveClaudeCode(
      snapshot([root, nested, deeper, parent, farParent, user, managed]),
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
    expect(find(resolved.elements, managed).applicability).toEqual({ type: 'global' });
  });

  it('lets CLAUDE.local.md shadow the base CLAUDE.md in the same directory only', async () => {
    const rootBase = element('CLAUDE.md', 'instructions', 'project');
    const rootLocal = element('CLAUDE.local.md', 'instructions', 'project');
    const nestedBase = element('docs/CLAUDE.md', 'instructions', 'project');

    const resolved = await resolveClaudeCode(snapshot([rootBase, rootLocal, nestedBase]));

    expect(find(resolved.elements, rootLocal).status).toBe('effective');
    const shadowed = find(resolved.elements, rootBase);
    expect(shadowed.status).toBe('shadowed');
    expect(shadowed.resolution.reason).toContain(rootLocal.id);
    expect(resolved.relations).toContainEqual({
      type: 'shadows',
      from: rootLocal.id,
      to: rootBase.id,
    });
    // A different directory has no local file, so the nested base stays effective.
    expect(find(resolved.elements, nestedBase).status).toBe('effective');
  });

  it('does not shadow a base in a different directory from the local file', async () => {
    const rootBase = element('CLAUDE.md', 'instructions', 'project');
    const nestedLocal = element('docs/CLAUDE.local.md', 'instructions', 'project');
    const parentLocal = element('../CLAUDE.local.md', 'instructions', 'project');
    const nestedBase = element('docs/CLAUDE.md', 'instructions', 'project');

    const resolved = await resolveClaudeCode(
      snapshot([rootBase, nestedLocal, parentLocal, nestedBase]),
    );

    // Removing the dirname guard would shadow the root base from the parent local
    // file and the nested base from the parent local file.
    expect(find(resolved.elements, rootBase).status).toBe('effective');
    expect(find(resolved.elements, nestedBase).status).toBe('shadowed');
    expect(resolved.relations).not.toContainEqual({
      type: 'shadows',
      from: parentLocal.id,
      to: rootBase.id,
    });
  });

  it('does not let an unavailable local file shadow the base', async () => {
    const base = element('CLAUDE.md', 'instructions', 'project');
    const local = element('CLAUDE.local.md', 'instructions', 'project', {
      status: 'skipped',
      reason: 'symlink-not-followed',
    });

    const resolved = await resolveClaudeCode(snapshot([base, local]));

    // Removing the observed-status guard would shadow the base from a file that
    // was never read.
    expect(find(resolved.elements, base).status).toBe('effective');
    expect(find(resolved.elements, local).status).toBe('unresolved');
  });

  it('ranks managed settings above project and user settings', async () => {
    const user = element('~/.claude/settings.json#permissions', 'permissions', 'user');
    const project = element('.claude/settings.json#permissions', 'permissions', 'project');
    const local = element('.claude/settings.local.json#permissions', 'permissions', 'project');
    const managed = element(
      '/Library/Application Support/ClaudeCode/settings.json#permissions',
      'permissions',
      'managed',
    );

    const resolved = await resolveClaudeCode(snapshot([user, project, local, managed]));

    expect(find(resolved.elements, managed).status).toBe('effective');
    expect(find(resolved.elements, local).status).toBe('shadowed');
    expect(find(resolved.elements, project).status).toBe('shadowed');
    expect(find(resolved.elements, user).status).toBe('shadowed');
    expect(resolved.relations).toContainEqual({
      type: 'shadows',
      from: managed.id,
      to: local.id,
    });
  });

  it('resolves hooks as an event pipeline with the event as target', async () => {
    const hooks = element('.claude/settings.json#hooks', 'hooks', 'project', {
      metadata: { eventNames: ['SessionStart', 'PreToolUse'] },
    });

    const resolved = await resolveClaudeCode(snapshot([hooks]));
    const entry = find(resolved.elements, hooks);

    expect(entry.status).toBe('effective');
    expect(entry.applicability).toEqual({ type: 'tool-event', target: 'SessionStart,PreToolUse' });
  });

  it('shadows a user setting overridden by the project', async () => {
    const user = element('~/.claude/settings.json#permissions', 'permissions', 'user');
    const project = element('.claude/settings.json#permissions', 'permissions', 'project');

    const resolved = await resolveClaudeCode(snapshot([user, project]));

    expect(find(resolved.elements, project).status).toBe('effective');
    const shadowed = find(resolved.elements, user);
    expect(shadowed.status).toBe('shadowed');
    expect(shadowed.resolution.reason).toContain(project.id);
    expect(resolved.relations).toContainEqual({
      type: 'shadows',
      from: project.id,
      to: user.id,
    });
  });

  it('prefers project-local settings over project settings', async () => {
    const project = element('.claude/settings.json#permissions', 'permissions', 'project');
    const local = element('.claude/settings.local.json#permissions', 'permissions', 'project');

    const resolved = await resolveClaudeCode(snapshot([project, local]));

    expect(find(resolved.elements, local).status).toBe('effective');
    expect(find(resolved.elements, project).status).toBe('shadowed');
  });

  it('keeps an opaque builtin layer effective', async () => {
    const opaque = element(
      '(builtin) claude-code instruction layers',
      'runtime-provided-instructions',
      'builtin',
    );

    const resolved = await resolveClaudeCode(snapshot([opaque]));
    const entry = find(resolved.elements, opaque);

    expect(entry.status).toBe('effective');
    expect(entry.resolution.strategy).toBe('runtime-defined');
  });

  it('records a skipped symlink as unresolved instead of guessing', async () => {
    const link = element('.claude/link', 'unknown', 'project', {
      status: 'skipped',
      reason: 'symlink-not-followed',
    });

    const resolved = await resolveClaudeCode(snapshot([link]));

    expect(find(resolved.elements, link).status).toBe('unresolved');
  });

  it('selects the same axes at every version position until a breakpoint exists', () => {
    const instruction = element('CLAUDE.md', 'instructions', 'project');

    expect(semanticsFor('2.0.9').position).toBe('below');
    expect(semanticsFor('2.1.100').position).toBe('within');
    expect(semanticsFor('2.2.0').position).toBe('above');
    expect(semanticsFor(null).position).toBe('unknown');
    expect(semanticsFor('2.0.9').axesFor(instruction)).toEqual(
      semanticsFor('2.2.0').axesFor(instruction),
    );
  });

  it('reflects the detected version position in resolution confidence', async () => {
    const instruction = element('CLAUDE.md', 'instructions', 'project');

    const within = await resolveClaudeCode(snapshot([instruction], '2.1.100'));
    const above = await resolveClaudeCode(snapshot([instruction], '2.2.0'));
    const below = await resolveClaudeCode(snapshot([instruction], '2.0.9'));
    const unknown = await resolveClaudeCode(snapshot([instruction], null));

    expect(within.resolution.confidence).toBe('verified');
    expect(above.resolution.confidence).toBe('unverified-runtime-version');
    expect(below.resolution.confidence).toBe('unverified-runtime-version');
    expect(unknown.resolution.confidence).toBe('unverified-runtime-version');
    // Confidence is downgraded for above, but the resolved facts are still
    // produced best-effort: acceptance criterion 12 says a newer runtime does
    // not block.
    expect(above.effectiveElementIds).toHaveLength(1);
  });
});
