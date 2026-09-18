import { describe, expect, it } from 'vitest';
import { CONSENT_GROUPS } from './consent.js';

/**
 * An independent, literal expectation, not re-derived from the production
 * constants: adding a search area to the adapter changes `CONSENT_GROUPS`, so
 * this test fails until the prompt is consciously updated (roadmap S2).
 *
 * The guarantee is over the adapter's declared path constants. A read added to
 * discovery without a constant would not be caught here; keeping reads declared
 * is what this test can enforce.
 */
const EXPECTED = {
  user: [
    {
      title: 'User and external references',
      locations: [
        '~/.config/opencode/AGENTS.md',
        '~/.claude/CLAUDE.md',
        '~/.config/opencode/opencode.json',
        '~/.config/opencode/opencode.jsonc',
        '~/.config/opencode/agent/**',
        '~/.config/opencode/agents/**',
        '~/.config/opencode/command/**',
        '~/.config/opencode/commands/**',
        '~/.config/opencode/skill/**',
        '~/.config/opencode/skills/**',
        '~/.config/opencode/plugin/**',
        '~/.config/opencode/plugins/**',
        '~/.config/opencode/tool/**',
        '~/.config/opencode/tools/**',
        '~/.config/opencode/mode/**',
        '~/.config/opencode/modes/**',
        '~/.claude/skills/**',
        '~/.agents/skills/**',
        '/Library/Application Support/opencode/opencode.json',
        '/Library/Application Support/opencode/opencode.jsonc',
        '../ (parent directories, bounded)',
      ],
    },
  ],
  install: [
    {
      title: 'Installation and version metadata',
      locations: [
        '~/.local/bin',
        '~/.npm-global/bin',
        'PATH directories (non-installer install)',
        'Homebrew Cellar version directories',
      ],
    },
  ],
};

describe('OpenCode consent groups', () => {
  it('lists exactly the locations the adapter declares', () => {
    expect(CONSENT_GROUPS).toEqual(EXPECTED);
  });
});
