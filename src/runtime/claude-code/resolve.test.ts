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
import { resolveClaudeCode } from './resolve.js';

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
    id: elementIdFor({ runtimeId: rid, origin, path }),
    native: { kind, origin, scope: origin === 'builtin' ? null : origin },
    source: { path },
    inspectability: kind === 'runtime-provided-instructions' ? 'opaque' : 'observable',
    metadata: options.metadata ?? {},
    status,
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
  };
}

function snapshot(elements: ObservedElement[]): ObservedSnapshot {
  return {
    schemaVersion: '1',
    snapshotId: generateObservedSnapshotId(),
    capturedAt: '2026-09-16T00:00:00.000Z',
    project: { id: 'proj', displayName: 'owner/repo', root: '/repo' },
    runtime: { id: rid, version: '2.1.100' },
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
});
