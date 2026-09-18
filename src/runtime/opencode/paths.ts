import { basename, join } from 'node:path';

/**
 * Known OpenCode discovery locations (design doc `opencode-model.md`, issues
 * #78, #93). The model doc is version-pinned and authoritative; the exact paths
 * remain adapter implementation details and may vary by runtime version.
 *
 * ```text
 * Project scope (implicit), under <project>/.opencode
 *   agent(s)/<name>.md          agents / subagents (mode decides which)
 *   command(s)/<name>.md        commands
 *   skill(s)/<name>/SKILL.md    skills
 *   plugin(s)/*.ts, *.js        local plugins
 *   tool(s)/**                  custom tools
 *   mode(s)/**                  agents (primary default; #149)
 *   theme(s)/**                 UI chrome; not modelled
 *   opencode.json[c]            project configuration
 *
 * Project instruction files (implicit), at the project root and nested:
 *   AGENTS.md (fallback CLAUDE.md), walked up to the repo root
 * Project cross-runtime skills (implicit):
 *   .claude/skills/<name>/SKILL.md, .agents/skills/<name>/SKILL.md
 *
 * User scope (requires consent), under <home>/.config/opencode
 *   AGENTS.md                   user instructions
 *   opencode.json[c]            user configuration
 *   the same element directories as the project scope
 * User cross-runtime skills (requires consent):
 *   ~/.claude/skills/**, ~/.agents/skills/**, ~/.claude/CLAUDE.md
 *
 * Managed scope (requires consent; macOS):
 *   /Library/Application Support/opencode/opencode.json[c]
 * MDM plist (upstream, unexercised): managed-preferences, opaque.
 *
 * Opaque
 *   built-in instruction layers and the remote org-defaults layer are recorded
 *   but never readable.
 * ```
 *
 * ## Default on-disk layout only
 *
 * OpenCode also accepts configuration through `OPENCODE_CONFIG`,
 * `OPENCODE_CONFIG_DIR`, and `OPENCODE_CONFIG_CONTENT` (model doc §2, §5.3).
 * Those are execution context: the design excludes environment variables from
 * the inventory and forbids persisting environment values, and neither existing
 * adapter reads `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. The adapter therefore
 * models the default `$XDG_*` layout and reads none of them; under such an
 * override a snapshot describes the default layout, not that run's layout. The
 * result carries that limit as a diagnostic note (`OVERLAY-NOTE`).
 *
 * ## Layout reconciliation
 *
 * The verified range is discrete (1.18.0, 1.18.30, 1.18.31), not a floor. The
 * model doc §10 makes a reconciliation due whenever the verified range moves:
 * compare these searched areas against the runtime's actual surface, record the
 * difference, and re-check every `[upstream]` and unexercised row. `../` parent
 * configuration is deliberately not searched by `pfl`: the model doc walks up
 * to the git root, but `pfl` resolves the canonical repo root as the project
 * root, so the walk is exactly the project root — a config above it would be an
 * out-of-project read with no consent scope behind it.
 */

/** User configuration directory, relative to the home directory. */
export const USER_CONFIG_DIR_RELATIVE = '.config/opencode';

/**
 * Configuration file names. Both are accepted; which one OpenCode reads when
 * both exist is not established by the model doc, so the adapter records both
 * and emits an ambiguity diagnostic rather than assuming a precedence.
 */
export const CONFIG_FILE_NAMES = ['opencode.json', 'opencode.jsonc'] as const;

/** Project configuration directory, relative to the project root. */
export const PROJECT_CONFIG_DIR = '.opencode';

/** User instruction file, relative to the user config directory. */
export const USER_INSTRUCTION_FILE = 'AGENTS.md';

/**
 * The fallback instruction file name, accepted in place of `AGENTS.md` in the
 * same directory only. `CLAUDE.md` is the Claude-compatible fallback (model doc
 * §4.1, §4.2).
 */
export const INSTRUCTION_FALLBACK_FILE = 'CLAUDE.md';

/** Cross-runtime skill roots, project-relative. */
export const PROJECT_COMPAT_SKILL_DIRS = ['.claude/skills', '.agents/skills'] as const;

/** Cross-runtime skill roots, home-relative (model doc §4.1). */
export const USER_COMPAT_SKILL_DIRS = ['.claude/skills', '.agents/skills'] as const;

/** The user-scope instruction fallback read under consent (model doc §4.1). */
export const USER_CLAUDE_INSTRUCTION_FILE = '.claude/CLAUDE.md';

/** Directories a project-wide instruction walk must not descend into. */
export const PROJECT_WALK_PRUNE_DIRECTORIES = ['node_modules', '.git'] as const;

/**
 * macOS managed-scope config directory (model doc §2 #7). Reading it is an
 * out-of-project read gated on consent; the base is injectable so a test never
 * touches `/Library`.
 */
export const MANAGED_CONFIG_DIR = '/Library/Application Support/opencode';

/**
 * Element directories accepted in both scopes. Singular and plural spellings are
 * both accepted (model doc §4.1); the plural form is the current spelling.
 */
export interface ElementDirSpec {
  /** Directory names accepted for this surface. */
  dirs: readonly string[];
  /** The harness kind an item in this directory maps to. */
  kind: OpenCodeElementKind;
  /** Whether frontmatter metadata is extracted from each file. */
  extractFrontmatter: boolean;
  /**
   * For an agent-like directory (`kind: 'subagents'`), the mode applied when a
   * file declares none. `agent(s)/` defaults to `subagent`; the legacy
   * `mode(s)/` directory defaults to `primary` (measured on 1.18.31: a
   * `mode/<name>.md` file loads as a primary agent).
   */
  defaultAgentMode?: 'primary' | 'subagent';
  /** Regular-file filter: only matching files are read and recorded. */
  selectFile: (relativePath: string) => boolean;
}

function hasExtension(relativePath: string, extensions: readonly string[]): boolean {
  const name = basename(relativePath).toLowerCase();
  return extensions.some((extension) => name.endsWith(extension));
}

function isSkillFile(relativePath: string): boolean {
  const segments = relativePath.split('/');
  return segments.length >= 2 && segments[segments.length - 1] === 'SKILL.md';
}

/** Element directories, in a stable order so snapshots do not churn. */
export const ELEMENT_DIRS: readonly ElementDirSpec[] = [
  {
    dirs: ['agent', 'agents'],
    kind: 'subagents',
    extractFrontmatter: true,
    defaultAgentMode: 'subagent',
    selectFile: (relativePath) => hasExtension(relativePath, ['.md']),
  },
  {
    dirs: ['command', 'commands'],
    kind: 'commands',
    extractFrontmatter: true,
    selectFile: (relativePath) => hasExtension(relativePath, ['.md']),
  },
  {
    dirs: ['skill', 'skills'],
    kind: 'skills',
    extractFrontmatter: true,
    selectFile: isSkillFile,
  },
  {
    dirs: ['plugin', 'plugins'],
    kind: 'plugin',
    extractFrontmatter: false,
    selectFile: (relativePath) => hasExtension(relativePath, ['.ts', '.js']),
  },
  {
    dirs: ['tool', 'tools'],
    kind: 'tools',
    extractFrontmatter: false,
    selectFile: () => true,
  },
  // Legacy `mode(s)/`: measured on 1.18.31 as loading each `<name>.md` as a
  // **primary** agent (the resolved `agent` map lists it with
  // `"mode": "primary"`), so it is agent-like with a primary default rather
  // than an unsupported directory (model doc §12; #149).
  {
    dirs: ['mode', 'modes'],
    kind: 'subagents',
    extractFrontmatter: true,
    defaultAgentMode: 'primary',
    selectFile: (relativePath) => hasExtension(relativePath, ['.md']),
  },
];

/**
 * UI-chrome directories that are not harness elements (model doc §4.1, §7):
 * themes are outside the harness boundary, so they are not searched at all.
 * Named in the module comment so the omission is explicit, not an oversight.
 */

/** Known element kinds inside the project/user scopes (model doc §7). */
export const KNOWN_ELEMENT_KINDS = [
  'instructions',
  'skills',
  'commands',
  'subagents',
  'agents',
  'mcp-configuration',
  'permissions',
  'model-configuration',
  'compaction-controls',
  'shell-environment',
  'project-configuration',
  'plugin',
  'tools',
  'references',
  'tooling-configuration',
  'runtime-provided-instructions',
] as const;

export type OpenCodeElementKind = (typeof KNOWN_ELEMENT_KINDS)[number];

/**
 * The kind a config file falls back to when it cannot be read or parsed: a
 * deliberate best-effort value, not a known kind. It stays out of
 * `KNOWN_ELEMENT_KINDS` so the classifier kind-coverage test does not demand a
 * facet mapping for it (roadmap M9 #131).
 */
export const FALLBACK_ELEMENT_KINDS = ['config'] as const;
export type OpenCodeFallbackKind = (typeof FALLBACK_ELEMENT_KINDS)[number];

/** The kind recorded for an item inside a known area the adapter cannot classify. */
export const UNKNOWN_ELEMENT_KIND = 'unknown' as const;

/**
 * Every kind an element builder may carry: a known kind, the explicit fallback,
 * or the explicit unknown. A bare `string` is not accepted, so a typo at a
 * known-kind call site is a compile error rather than a different `ElementId`
 * (roadmap M9 #131).
 */
export type OpenCodeRecordedKind =
  | OpenCodeElementKind
  | OpenCodeFallbackKind
  | typeof UNKNOWN_ELEMENT_KIND;

/** Expands the user config directory from an injected home. */
export function userConfigDir(home: string): string {
  return join(home, USER_CONFIG_DIR_RELATIVE);
}
