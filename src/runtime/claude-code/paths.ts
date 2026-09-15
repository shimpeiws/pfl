/**
 * Known Claude Code discovery locations (design doc §31.1). Exact paths and
 * resolution rules remain adapter implementation details and may vary by
 * runtime version.
 */

/** Project-scoped instruction file, read implicitly. */
export const PROJECT_INSTRUCTION_FILES = ['CLAUDE.md'] as const;

/** Project-scoped configuration directory. */
export const PROJECT_CONFIG_DIR = '.claude';

/** User/global configuration directory (requires consent to read). */
export const USER_CONFIG_DIR = '~/.claude';

/** Known element kinds inside the project/user scopes. */
export const KNOWN_ELEMENT_KINDS = [
  'instructions',
  'rules',
  'skills',
  'commands',
  'subagents',
  'hooks',
  'permissions',
  'approval-policy',
  'mcp-configuration',
  'output-style',
  'memory',
  'plugin',
  'runtime-provided-instructions',
] as const;
