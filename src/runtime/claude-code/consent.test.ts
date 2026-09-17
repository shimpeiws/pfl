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
const EXPECTED = [
  {
    title: 'Project',
    locations: ['./CLAUDE.md', './CLAUDE.local.md', './.claude/**', './.mcp.json'],
  },
  {
    title: 'User',
    locations: [
      '~/.claude/CLAUDE.md',
      '~/.claude/settings.json',
      '~/.claude/settings.local.json',
      '~/.claude/skills/**',
      '~/.claude/agents/**',
      '~/.claude/commands/**',
      '~/.claude/rules/**',
      '~/.claude/output-styles/**',
      '~/.claude/hooks/**',
      '~/.claude/projects/**/memory/**',
      '~/.claude/plugins/**',
      '~/.claude.json',
      '/Library/Application Support/ClaudeCode/CLAUDE.md',
      '/Library/Application Support/ClaudeCode/settings.json',
    ],
  },
  {
    title: 'Installation and version metadata',
    locations: [
      '~/.local/share/claude',
      '~/.local/bin/claude',
      '~/.local/share/claude/versions',
      '~/.claude/.last-update-result.json',
    ],
  },
  {
    title: 'External references',
    locations: [
      '../ (parent directories, bounded)',
      'Plugin directories referenced by Claude Code config',
      'MCP configuration metadata',
    ],
  },
];

describe('Claude Code consent groups', () => {
  it('lists exactly the locations the adapter declares', () => {
    expect(CONSENT_GROUPS).toEqual(EXPECTED);
  });
});
