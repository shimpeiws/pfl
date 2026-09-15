import { join } from 'node:path';

/**
 * Known Claude Code discovery locations, verified against Claude Code 2.1.272 on
 * macOS (design doc §31.1). The exact paths remain adapter implementation
 * details and may vary by runtime version.
 *
 * ```text
 * Project scope (implicit)
 *   CLAUDE.md, CLAUDE.local.md      instructions
 *   .claude/settings.json           permissions / hooks / outputStyle / mcp / plugins
 *   .claude/settings.local.json     local overrides of the same keys
 *   .claude/skills/<name>/SKILL.md  skills
 *   .claude/agents/*.md             subagents
 *   .claude/commands/<nested>/*.md  legacy slash commands
 *   .claude/rules/**                rules
 *   .claude/output-styles/*.md      output styles
 *   .claude/hooks/**                hook scripts
 *   .mcp.json                       project MCP servers
 *
 * User scope (requires consent), under <home>/.claude
 *   CLAUDE.md, settings.json        user instructions, user settings
 *   skills|agents|commands|rules|output-styles|hooks/**
 *   projects/<encoded-cwd>/memory/**  persistent memory
 *   plugins/**                      plugin-provided elements
 *   <home>/.claude.json             user MCP servers
 *
 * Managed scope (macOS) is not discovered yet:
 *   /Library/Application Support/ClaudeCode/{CLAUDE.md,settings.json}
 *
 * Opaque
 *   built-in instruction layers are recorded but never readable.
 * ```
 */

/** Project-scoped instruction files, read implicitly. */
export const PROJECT_INSTRUCTION_FILES = ['CLAUDE.md', 'CLAUDE.local.md'] as const;

/** Project-scoped configuration directory. */
export const PROJECT_CONFIG_DIR = '.claude';

/** Project-scoped MCP configuration file. */
export const PROJECT_MCP_FILE = '.mcp.json';

/** User instruction file, relative to the user config directory. */
export const USER_INSTRUCTION_FILE = 'CLAUDE.md';

/** User-scoped element directories, relative to the user config directory. */
export const USER_ELEMENT_DIRS = [
  'skills',
  'agents',
  'commands',
  'rules',
  'output-styles',
  'hooks',
] as const;

/** Persistent-memory area, relative to the user config directory (design doc §24). */
export const USER_PROJECTS_DIR = 'projects';

/** Plugin directory, relative to the user config directory. */
export const USER_PLUGINS_DIR = 'plugins';

/** Settings file names inside a config directory. */
export const SETTINGS_FILES = ['settings.json', 'settings.local.json'] as const;

/** Expands the user config directory from an injected home. */
export function userConfigDir(home: string): string {
  return join(home, PROJECT_CONFIG_DIR);
}

/** Encodes an absolute project path the way Claude Code names per-project dirs (`/` -> `-`). */
export function encodeProjectDir(root: string): string {
  return root.replaceAll('/', '-');
}

/** Known element kinds inside the project/user scopes (design doc §31.1). */
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

export type ClaudeCodeElementKind = (typeof KNOWN_ELEMENT_KINDS)[number];
