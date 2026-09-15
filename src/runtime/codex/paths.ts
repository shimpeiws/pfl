/**
 * Known Codex discovery locations (design doc §31.2). Exact paths and
 * resolution rules remain adapter implementation details and may vary by
 * runtime version.
 */

/** Project-scoped instruction files, in fallback order. */
export const PROJECT_INSTRUCTION_FILES = ['AGENTS.md', 'AGENTS.override.md'] as const;

/** User/global configuration directory (requires consent to read). */
export const USER_CONFIG_DIR = '~/.codex';

/** Known element kinds inside the project/user scopes. */
export const KNOWN_ELEMENT_KINDS = [
  'instructions',
  'fallback-instructions',
  'skills',
  'skill-dependencies',
  'custom-agents',
  'multi-agent-configuration',
  'mcp-configuration',
  'hooks',
  'permissions',
  'approval-sandbox',
  'memory',
  'compaction-controls',
  'runtime-provided-instructions',
] as const;
