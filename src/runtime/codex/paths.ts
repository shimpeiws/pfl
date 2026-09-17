import { join } from 'node:path';

/**
 * Known Codex discovery locations, verified against Codex 0.154.0 on macOS
 * (design doc §31.2). Exact paths remain adapter implementation details and may
 * vary by runtime version. The layout below is backed by fixtures in
 * `src/runtime/codex/discovery.test.ts`, so a runtime change fails a test
 * instead of silently invalidating this comment.
 *
 * ```text
 * Project scope (implicit)
 *   AGENTS.md                 instructions (project root, nested directories,
 *                             and — read under consent — parent directories)
 *   AGENTS.override.md        fallback instructions; replaces the base file in
 *                             the same directory only, never across directories
 *   .codex/skills/**          skills (project-scoped)
 *
 * User scope (requires consent), under <home>/.codex
 *   AGENTS.md                 instructions
 *   config.toml               approval/sandbox, model/context, MCP, plugins,
 *                             marketplaces, projects.*, shell_environment_policy
 *   hooks.json                hooks
 *   skills, rules, memories, hooks   element directories
 *
 * `~/.codex/agents/` does not exist in the verified range, so it is not a
 * search area; the `custom-agents` kind is withdrawn with it.
 *
 * Codex has project-scoped configuration, stored centrally in `config.toml`
 * under `[projects."<absolute path>"]` rather than in the project directory.
 *
 * Opaque
 *   built-in instruction layers are recorded but never readable.
 * ```
 */

/** Project-scoped instruction files, in fallback order. */
export const PROJECT_INSTRUCTION_FILES = ['AGENTS.md', 'AGENTS.override.md'] as const;

/** Project configuration directory, relative to the project root. */
export const PROJECT_CONFIG_DIR = '.codex';

/** Project-scoped element directory under `PROJECT_CONFIG_DIR`. */
export const PROJECT_SKILLS_DIR = 'skills';

/** Directories a project-wide instruction walk must not descend into. */
export const PROJECT_WALK_PRUNE_DIRECTORIES = ['node_modules', '.git'] as const;

/** User instruction file, relative to the user config directory. */
export const USER_INSTRUCTION_FILE = 'AGENTS.md';

/** User configuration file (TOML), relative to the user config directory. */
export const USER_CONFIG_FILE = 'config.toml';

/** User hooks file (JSON), relative to the user config directory. */
export const USER_HOOKS_FILE = 'hooks.json';

/** User-scoped element directories, relative to the user config directory. */
export const USER_ELEMENT_DIRS = ['skills', 'rules', 'memories', 'hooks'] as const;

/**
 * `config.toml` sections the adapter models. A section that is not listed is
 * recorded as a known-unsupported area rather than silently ignored, so a new
 * runtime section surfaces instead of disappearing. `[hooks.state]` is
 * deliberately unlisted: it is runtime execution state, and `hooks.json` is the
 * one source of hooks.
 */
export const MODELLED_CONFIG_SECTIONS = [
  'mcp_servers',
  'plugins',
  'marketplaces',
  'projects',
  'profiles',
  'sandbox_workspace_write',
  'shell_environment_policy',
] as const;

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
  'multi-agent-configuration',
  'mcp-configuration',
  'hooks',
  'permissions',
  'approval-sandbox',
  'memory',
  'compaction-controls',
  'plugin',
  'shell-environment',
  'project-configuration',
  'runtime-provided-instructions',
] as const;

export type CodexElementKind = (typeof KNOWN_ELEMENT_KINDS)[number];

/** How each user element directory maps to a harness kind. */
export const USER_DIR_KIND: Record<(typeof USER_ELEMENT_DIRS)[number], CodexElementKind> = {
  skills: 'skills',
  rules: 'permissions',
  memories: 'memory',
  hooks: 'hooks',
};
