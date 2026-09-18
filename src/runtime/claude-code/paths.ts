import { join } from 'node:path';

/**
 * Known Claude Code discovery locations, verified against Claude Code 2.1.272 on
 * macOS (design doc §31.1). The exact paths remain adapter implementation
 * details and may vary by runtime version.
 *
 * ```text
 * Project scope (implicit)
 *   CLAUDE.md, CLAUDE.local.md      instructions (project root, nested
 *                                   directories, and — read under consent —
 *                                   parent directories)
 *   .claude/settings.json           permissions / hooks / outputStyle / mcp / plugins
 *   .claude/settings.local.json     local overrides of the same keys
 *   .claude/skills/<name>/SKILL.md  skills
 *   .claude/agents/*.md             subagents
 *   .claude/commands/<nested>/*.md  legacy slash commands
 *   .claude/rules/**                rules
 *   .claude/output-styles/*.md      output styles
 *   .claude/hooks/**                hook scripts
 *   .mcp.json                       project MCP servers (server names only)
 *
 * User scope (requires consent), under <home>/.claude
 *   CLAUDE.md, settings.json        user instructions, user settings
 *   skills|agents|commands|rules|output-styles|hooks/**
 *   projects/<encoded-cwd>/memory/**  persistent memory
 *   plugins/**                      plugin-provided elements
 *   <home>/.claude.json             user MCP servers
 *
 * Managed scope (requires consent, macOS only):
 *   /Library/Application Support/ClaudeCode/{CLAUDE.md,settings.json}
 *   system-wide policy; the read is an out-of-project read and is gated on the
 *   same consent as the user scope. The directory is a parameter of discovery
 *   (`collectClaudeCodeHarness`) so a test can inject a base and never touch
 *   `/Library`.
 *
 * Opaque
 *   built-in instruction layers are recorded but never readable.
 * ```
 */

/** Project-scoped instruction files, read implicitly. */
export const PROJECT_INSTRUCTION_FILES = ['CLAUDE.md', 'CLAUDE.local.md'] as const;

/** Directories a project-wide instruction walk must not descend into. */
export const PROJECT_WALK_PRUNE_DIRECTORIES = ['node_modules', '.git'] as const;

/**
 * macOS managed-scope config directory (design doc §31.1). Reading it is an
 * out-of-project read gated on consent. Absolute because the location is
 * system-wide, not home-relative.
 */
export const MANAGED_CONFIG_DIR = '/Library/Application Support/ClaudeCode';

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

/**
 * The kind a settings file falls back to when it cannot be read or parsed: a
 * deliberate best-effort value, not a known kind. It stays out of
 * `KNOWN_ELEMENT_KINDS` so the classifier kind-coverage test does not demand
 * a facet mapping for it (roadmap M9 #131). The shared observed-element boundary
 * still takes a `string`, which is the separate design #131 leaves open.
 */
export const FALLBACK_ELEMENT_KINDS = ['settings'] as const;
export type ClaudeCodeFallbackKind = (typeof FALLBACK_ELEMENT_KINDS)[number];

/** The kind recorded for an item inside a known area the adapter cannot classify. */
export const UNKNOWN_ELEMENT_KIND = 'unknown' as const;

/**
 * Every kind an element builder may carry: a known kind, the explicit fallback,
 * or the explicit unknown. A bare `string` is no longer accepted, so a typo at a
 * known-kind call site is a compile error rather than a different `ElementId`
 * (roadmap M9 #131).
 */
export type ClaudeCodeRecordedKind =
  | ClaudeCodeElementKind
  | ClaudeCodeFallbackKind
  | typeof UNKNOWN_ELEMENT_KIND;
