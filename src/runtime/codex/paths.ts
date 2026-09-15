import { join } from 'node:path';

/**
 * Known Codex discovery locations, verified against Codex 0.154.0 on macOS
 * (design doc §31.2). Exact paths remain adapter implementation details and may
 * vary by runtime version.
 *
 * ```text
 * Project scope (implicit)
 *   AGENTS.md                 instructions
 *   AGENTS.override.md        fallback instructions (override semantics are M2)
 *
 * User scope (requires consent), under <home>/.codex
 *   AGENTS.md                 instructions
 *   config.toml               approval/sandbox, model/context, MCP, plugins
 *   hooks.json                hooks (event names)
 *   skills, agents, rules, memories, hooks   element directories
 *
 * Codex has no project-scoped configuration directory in 0.154.0.
 *
 * Opaque
 *   built-in instruction layers are recorded but never readable.
 * ```
 */

/** Project-scoped instruction files, in fallback order. */
export const PROJECT_INSTRUCTION_FILES = ['AGENTS.md', 'AGENTS.override.md'] as const;

/** User instruction file, relative to the user config directory. */
export const USER_INSTRUCTION_FILE = 'AGENTS.md';

/** User configuration file (TOML), relative to the user config directory. */
export const USER_CONFIG_FILE = 'config.toml';

/** User hooks file (JSON), relative to the user config directory. */
export const USER_HOOKS_FILE = 'hooks.json';

/** User-scoped element directories, relative to the user config directory. */
export const USER_ELEMENT_DIRS = ['skills', 'agents', 'rules', 'memories', 'hooks'] as const;

/** Expands the user config directory from an injected home. */
export function userConfigDir(home: string): string {
  return join(home, '.codex');
}

/** Known element kinds inside the project/user scopes (design doc §31.2). */
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

export type CodexElementKind = (typeof KNOWN_ELEMENT_KINDS)[number];

/** How each user element directory maps to a harness kind. */
export const USER_DIR_KIND: Record<(typeof USER_ELEMENT_DIRS)[number], CodexElementKind> = {
  skills: 'skills',
  agents: 'custom-agents',
  rules: 'permissions',
  memories: 'memory',
  hooks: 'hooks',
};
