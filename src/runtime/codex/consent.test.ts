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
    locations: ['./AGENTS.md', './AGENTS.override.md', './.codex/skills/**'],
  },
  {
    title: 'User',
    locations: [
      '~/.codex/config.toml',
      '~/.codex/AGENTS.md',
      '~/.codex/skills/**',
      '~/.codex/rules/**',
      '~/.codex/memories/**',
      '~/.codex/hooks/**',
      '~/.codex/hooks.json',
    ],
  },
  {
    title: 'Installation and version metadata',
    locations: [
      '~/.codex/packages/standalone/releases',
      '~/.codex/packages/standalone',
      '~/.local/bin',
      '~/.local/lib/node_modules/**',
      '~/.npm-global/bin',
      '~/.npm-global/lib/node_modules/**',
      'PATH directories (non-installer install)',
      'Homebrew Cellar version directories',
    ],
  },
  {
    title: 'External references',
    locations: ['../ (parent directories, bounded)', 'MCP configuration metadata'],
  },
];

describe('Codex consent groups', () => {
  it('lists exactly the locations the adapter declares', () => {
    expect(CONSENT_GROUPS).toEqual(EXPECTED);
  });
});
