import { describe, expect, it } from 'vitest';
import {
  elementIdFor,
  generateInterpretationId,
  generateObservedSnapshotId,
  generateResolvedSnapshotId,
  runtimeId,
  type ElementId,
  type ElementIdentity,
} from './ids.js';

describe('runtimeId', () => {
  it('accepts the known runtime ids', () => {
    expect(runtimeId('claude-code')).toBe('claude-code');
    expect(runtimeId('codex')).toBe('codex');
  });

  it('rejects ids that cannot be a scope key', () => {
    expect(() => runtimeId('Claude Code')).toThrow(TypeError);
    expect(() => runtimeId('')).toThrow(TypeError);
    expect(() => runtimeId('1codex')).toThrow(TypeError);
  });
});

describe('snapshot id generators', () => {
  it('produce the §25 shapes', () => {
    expect(generateObservedSnapshotId()).toMatch(/^obs_[0-9a-f]{12}$/);
    expect(generateResolvedSnapshotId()).toMatch(/^res_[0-9a-f]{12}$/);
    expect(generateInterpretationId()).toMatch(/^int_[0-9a-f]{12}$/);
  });

  it('do not repeat', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateObservedSnapshotId()));
    expect(ids.size).toBe(100);
  });
});

describe('elementIdFor', () => {
  const identity = {
    runtimeId: runtimeId('claude-code'),
    origin: 'project',
    path: '.claude/skills/foo',
    kind: 'skills',
  };

  it('is stable for identical input', () => {
    expect(elementIdFor(identity)).toBe(elementIdFor({ ...identity }));
  });

  it('changes when runtime, origin, path, or kind changes', () => {
    const base = elementIdFor(identity);
    expect(elementIdFor({ ...identity, runtimeId: runtimeId('codex') })).not.toBe(base);
    expect(elementIdFor({ ...identity, origin: 'user' })).not.toBe(base);
    expect(elementIdFor({ ...identity, path: '.claude/skills/bar' })).not.toBe(base);
    expect(elementIdFor({ ...identity, kind: 'commands' })).not.toBe(base);
  });

  it('has a stable, filesystem-safe shape', () => {
    expect(elementIdFor(identity)).toMatch(/^el_[0-9a-f]{16}$/);
  });

  it('gives two elements from one file distinct ids, even without a path fragment', () => {
    // The collision fixture (roadmap §5 M8): a `settings.json` yields several
    // elements. Here the two elements deliberately share runtime, origin, and
    // path — the adapter "forgot" a fragment — and differ only in native kind.
    // Before the kind joined the identity these two produced one id.
    const fromOneFile = (kind: string): ElementId =>
      elementIdFor({
        runtimeId: runtimeId('claude-code'),
        origin: 'project',
        path: '.claude/settings.json',
        kind,
      });

    const permissions = fromOneFile('permissions');
    const hooks = fromOneFile('hooks');

    expect(permissions).toMatch(/^el_[0-9a-f]{16}$/);
    expect(hooks).toMatch(/^el_[0-9a-f]{16}$/);
    expect(permissions).not.toBe(hooks);
  });

  it('is opaque: the display path it derives from is not recoverable from it', () => {
    // The identity uses the *display* path (`~/.claude/…`, project-relative),
    // never an absolute one, so an id embeds neither the account name nor the
    // machine's layout, and it leaks no path segment (ADR 0003). The discovery
    // test in `claude-code/discovery.test.ts` covers the independence directly;
    // here the id is opaque to its input.
    const identity = (path: string): ElementIdentity => ({
      runtimeId: runtimeId('claude-code'),
      origin: 'user',
      path,
      kind: 'permissions',
    });
    const id = elementIdFor(identity('~/.claude/settings.json#permissions'));

    expect(id).not.toContain('alice');
    expect(id).not.toContain('settings.json');
    expect(id).not.toContain('/');
  });
});
