import { describe, expect, it } from 'vitest';
import {
  elementIdFor,
  generateInterpretationId,
  generateObservedSnapshotId,
  generateResolvedSnapshotId,
  runtimeId,
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
  };

  it('is stable for identical input', () => {
    expect(elementIdFor(identity)).toBe(elementIdFor({ ...identity }));
  });

  it('changes when runtime, origin, or path changes', () => {
    const base = elementIdFor(identity);
    expect(elementIdFor({ ...identity, runtimeId: runtimeId('codex') })).not.toBe(base);
    expect(elementIdFor({ ...identity, origin: 'user' })).not.toBe(base);
    expect(elementIdFor({ ...identity, path: '.claude/skills/bar' })).not.toBe(base);
  });

  it('has a stable, filesystem-safe shape', () => {
    expect(elementIdFor(identity)).toMatch(/^el_[0-9a-f]{16}$/);
  });
});
