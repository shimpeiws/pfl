import type { ConsentLocationGroup } from '../../discovery/consent.js';

/** Display name used in the consent prompt and inspect output. */
export const RUNTIME_NAME = 'Codex';

/** Locations the consent prompt lists before reading outside the project. */
export const CONSENT_GROUPS: readonly ConsentLocationGroup[] = [
  { title: 'Project', locations: ['./AGENTS.md', './AGENTS.override.md'] },
  {
    title: 'User',
    locations: [
      '~/.codex/config.toml',
      '~/.codex/AGENTS.md',
      '~/.codex/skills/**',
      '~/.codex/agents/**',
      '~/.codex/memories/**',
    ],
  },
  {
    title: 'Installation and version metadata',
    locations: ['~/.codex/packages/standalone/releases/**'],
  },
  { title: 'External references', locations: ['MCP configuration metadata'] },
];
