import { describe, expect, it } from 'vitest';
import { fragmentKeyOf, withFragment } from './element-path.js';

describe('fragment path convention', () => {
  it('round-trips a file path and its fragment key', () => {
    expect(withFragment('.claude/settings.json', 'permissions')).toBe(
      '.claude/settings.json#permissions',
    );
    expect(fragmentKeyOf(withFragment('.claude/settings.json', 'permissions'))).toBe('permissions');
  });

  it('reports no fragment for a whole-file display path', () => {
    expect(fragmentKeyOf('CLAUDE.md')).toBeNull();
    expect(fragmentKeyOf('~/.claude/skills/bar/SKILL.md')).toBeNull();
  });

  it('splits on the first separator, so a key containing one survives intact', () => {
    expect(fragmentKeyOf('.codex/config.toml#projects./repo')).toBe('projects./repo');
  });
});
