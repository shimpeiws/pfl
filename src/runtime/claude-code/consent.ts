import type { ConsentLocationGroup } from '../../discovery/consent.js';

/** Display name used in the consent prompt and inspect output (design doc §24). */
export const RUNTIME_NAME = 'Claude Code';

/** Locations the §24 prompt lists before reading outside the project. */
export const CONSENT_GROUPS: readonly ConsentLocationGroup[] = [
  { title: 'Project', locations: ['./CLAUDE.md', './CLAUDE.local.md', './.claude/**'] },
  {
    title: 'User',
    locations: [
      '~/.claude/settings.json',
      '~/.claude/skills/**',
      '~/.claude/agents/**',
      '~/.claude/projects/**/memory/**',
    ],
  },
  {
    title: 'Installation and version metadata',
    locations: ['~/.local/share/claude/versions/**'],
  },
  {
    title: 'External references',
    locations: [
      'Plugin directories referenced by Claude Code config',
      'MCP configuration metadata',
    ],
  },
];
