import { describe, expect, it } from 'vitest';
import { runtimeId } from '../core/ids.js';
import { buildObservedElement } from './observed-element.js';
import { duplicateNameGroups } from './duplicate-names.js';

const RT = runtimeId('test');

function observed(
  path: string,
  kind: string,
  origin: 'project' | 'user' | 'plugin' | 'managed' = 'project',
  status: 'observed' | 'skipped' = 'observed',
) {
  return buildObservedElement({
    runtimeId: RT,
    origin,
    scope: origin,
    kind,
    path,
    ...(status !== 'observed' ? { status, reason: 'symlink-not-followed' as const } : {}),
  });
}

function identityOf(e: { native: { kind: string }; source: { path?: string } }) {
  const path = e.source.path;
  if (path === undefined) return null;
  const segments = path.split('/');
  const name = path.endsWith('/SKILL.md')
    ? (segments.at(-2) ?? '')
    : path.includes('.')
      ? path.slice(0, path.lastIndexOf('.'))
      : (segments.at(-1) ?? '');
  return { kind: e.native.kind, name };
}

describe('duplicateNameGroups', () => {
  it('returns no groups for a single-scope harness', () => {
    const elements = [
      observed('a/skills/foo/SKILL.md', 'skills'),
      observed('a/skills/bar/SKILL.md', 'skills'),
    ];
    expect(duplicateNameGroups(elements, identityOf)).toEqual([]);
  });

  it('detects a cross-scope duplicate', () => {
    const elements = [
      observed('.claude/skills/foo/SKILL.md', 'skills', 'project'),
      observed('~/.claude/skills/foo/SKILL.md', 'skills', 'user'),
    ];
    const groups = duplicateNameGroups(elements, identityOf);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({
      kind: 'skills',
      name: 'foo',
      entries: [
        { path: '.claude/skills/foo/SKILL.md', origin: 'project' },
        { path: '~/.claude/skills/foo/SKILL.md', origin: 'user' },
      ],
      pluginOnly: false,
      hasPlugin: false,
    });
  });

  it('skips non-observed elements (symlinks/unreadable)', () => {
    const elements = [
      observed('.claude/skills/foo/SKILL.md', 'skills', 'project'),
      observed('~/.claude/skills/foo/SKILL.md', 'skills', 'user', 'skipped'),
    ];
    expect(duplicateNameGroups(elements, identityOf)).toEqual([]);
  });

  it('marks all-plugin groups as pluginOnly', () => {
    const elements = [
      observed('~/.claude/plugins/a/skills/x/SKILL.md', 'skills', 'plugin'),
      observed('~/.claude/plugins/b/skills/x/SKILL.md', 'skills', 'plugin'),
    ];
    const groups = duplicateNameGroups(elements, identityOf);
    expect(groups).toHaveLength(1);
    const group = groups[0];
    if (group === undefined) throw new Error('expected one group');
    expect(group.pluginOnly).toBe(true);
    expect(group.hasPlugin).toBe(true);
  });

  it('marks mixed-origin groups as not pluginOnly but hasPlugin', () => {
    const elements = [
      observed('~/.claude/plugins/a/skills/x/SKILL.md', 'skills', 'plugin'),
      observed('~/.claude/skills/x/SKILL.md', 'skills', 'user'),
    ];
    const groups = duplicateNameGroups(elements, identityOf);
    expect(groups).toHaveLength(1);
    const group = groups[0];
    if (group === undefined) throw new Error('expected one group');
    expect(group.pluginOnly).toBe(false);
    expect(group.hasPlugin).toBe(true);
  });

  it('sorts entries by path alphabetically', () => {
    const elements = [
      observed('z/skills/foo/SKILL.md', 'skills', 'user'),
      observed('a/skills/foo/SKILL.md', 'skills', 'project'),
    ];
    const groups = duplicateNameGroups(elements, identityOf);
    const group = groups[0];
    if (group === undefined) throw new Error('expected one group');
    expect(group.entries.map((e) => e.path)).toEqual([
      'a/skills/foo/SKILL.md',
      'z/skills/foo/SKILL.md',
    ]);
  });

  it('groups by kind + name, not by kind alone', () => {
    const elements = [
      observed('a/skills/foo/SKILL.md', 'skills'),
      observed('a/skills/bar/SKILL.md', 'skills'),
    ];
    expect(duplicateNameGroups(elements, identityOf)).toEqual([]);
  });

  it('skips identityOf nulls', () => {
    const elements = [
      observed('a/skills/foo/SKILL.md', 'skills'),
      observed('a/unknown/file.txt', 'unknown'),
    ];
    expect(duplicateNameGroups(elements, identityOf)).toEqual([]);
  });
});
