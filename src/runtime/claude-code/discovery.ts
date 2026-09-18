import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { assembleObservedSnapshot } from '../../discovery/assemble.js';
import { duplicateNameGroups } from '../../discovery/duplicate-names.js';
import { frontmatterMetadata, readFrontmatter } from '../../discovery/frontmatter.js';
import { filterToAllowlist } from '../../discovery/metadata.js';
import { buildObservedElement } from '../../discovery/observed-element.js';
import { walkHarnessPaths } from '../../discovery/walk.js';
import type { Diagnostic } from '../../core/diagnostics.js';
import { withFragment } from '../../core/element-path.js';
import { runtimeId } from '../../core/ids.js';
import type {
  NativeOrigin,
  ObservedElement,
  ObservedSnapshot,
  SafeMetadataValue,
} from '../../core/observed.js';
import { MAX_ANCESTOR_DIRS, MAX_PARSE_BYTES, limitExceededDiagnostic } from '../../limits.js';
import { readTextFileGuarded } from '../../util/fs.js';
import { packageVersion } from '../../version.js';
import type { AccessPolicy, ProjectContext } from '../types.js';
import { grants } from '../../discovery/gate.js';
import {
  addKnownFile as sharedAddKnownFile,
  builtinLayer,
  createElementBuilders,
  hardlinkDiagnostic,
  isRecord,
  malformedFrontmatterDiagnostic,
  nonRegularDiagnostic,
  pushWalkedEntry,
  toObservedProject,
  unreadableDiagnostic,
} from '../scaffold.js';
import { detectClaudeCode } from './detect.js';
import { CLAUDE_CODE_SAFE_METADATA_ALLOWLIST } from './metadata.js';
import {
  MANAGED_CONFIG_DIR,
  PROJECT_CONFIG_DIR,
  PROJECT_INSTRUCTION_FILES,
  PROJECT_MCP_FILE,
  PROJECT_WALK_PRUNE_DIRECTORIES,
  SETTINGS_FILES,
  USER_ELEMENT_DIRS,
  USER_INSTRUCTION_FILE,
  USER_PLUGINS_DIR,
  USER_PROJECTS_DIR,
  encodeProjectDir,
  userConfigDir,
  type ClaudeCodeElementKind,
  type ClaudeCodeRecordedKind,
} from './paths.js';
import { redactClaudeCode } from './redact.js';

/**
 * Discovers the Claude Code harness and builds an immutable ObservedSnapshot
 * (design doc §10, §31.1). Static only: nothing is executed, symlinks are never
 * followed, and user-scope paths are opened only when `access` allows it.
 *
 * Elements inside a known area are classified by their path; anything else in a
 * known area is preserved as `unsupported-by-adapter` rather than dropped.
 * Settings files contribute structural config elements (permissions, hooks,
 * output style, MCP, plugins) with allowlisted metadata only — key-level
 * precedence is resolution (M2), not discovery.
 */

const RUNTIME_ID = runtimeId('claude-code');
const USER_PREFIX = '~/.claude';

// The shared element builders, parameterised by this adapter's kind union so a
// misspelled kind is a compile error (roadmap M9 #90, #131).
const builders = createElementBuilders<ClaudeCodeRecordedKind>(RUNTIME_ID);
const { symlinkElement, unreadableElement, skippedElement, skippedNonRegularElement } = builders;

const USER_DIR_KIND: Record<(typeof USER_ELEMENT_DIRS)[number], ClaudeCodeElementKind> = {
  skills: 'skills',
  agents: 'subagents',
  commands: 'commands',
  rules: 'rules',
  'output-styles': 'output-style',
  hooks: 'hooks',
};

const PLUGIN_KIND_BY_DIR: Record<string, ClaudeCodeElementKind> = {
  skills: 'skills',
  agents: 'subagents',
  commands: 'commands',
  rules: 'rules',
  'output-styles': 'output-style',
  hooks: 'hooks',
};

/** The kinds that form a named catalog, where a cross-scope collision is possible. */
const CATALOG_KINDS: ReadonlySet<string> = new Set(['skills', 'subagents', 'commands']);

/** The catalog name an element contributes, when it is a named catalog entry. */
function catalogIdentity(element: ObservedElement): { kind: string; name: string } | null {
  if (element.status !== 'observed') return null;
  const kind = element.native.kind;
  if (!CATALOG_KINDS.has(kind)) return null;
  const path = element.source.path;
  if (path === undefined) return null;

  if (path.endsWith('/SKILL.md')) {
    const segments = path.split('/');
    return { kind, name: segments[segments.length - 2] as string };
  }
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return { kind, name: dot > 0 ? name.slice(0, dot) : name };
}

/**
 * Emits one diagnostic per catalog name defined more than once. Claude Code
 * resolves duplicates deterministically (project > user > managed), so the
 * diagnostic records the fact without asserting a winner. Plugin-provided
 * entries are namespaced by plugin name at the runtime level; mixed-origin
 * groups (plugin + non-plugin) are split so non-plugin collisions are still
 * reported. All-plugin groups may be one plugin installed at more than one path.
 */
function detectDuplicateNames(
  elements: readonly ObservedElement[],
  diagnostics: Diagnostic[],
): void {
  const groups = duplicateNameGroups(elements, catalogIdentity);
  for (const { kind, name, entries, pluginOnly, hasPlugin } of groups) {
    // Mixed plugin + non-plugin: only suppress for skills (where plugin
    // namespacing is verified). For subagents/commands, always diagnose.
    if (hasPlugin && !pluginOnly && kind === 'skills') {
      const nonPluginEntries = entries.filter((e) => e.origin !== 'plugin');
      const pluginEntries = entries.filter((e) => e.origin === 'plugin');

      if (nonPluginEntries.length > 1) {
        const joined = nonPluginEntries.map((e) => e.path).join(', ');
        diagnostics.push({
          severity: 'warning',
          code: 'duplicate-element-name',
          message: `${kind} name "${name}" is defined more than once (${joined})`,
          ...(nonPluginEntries[0] !== undefined ? { path: nonPluginEntries[0].path } : {}),
        });
      }
      if (pluginEntries.length > 1) {
        const joined = pluginEntries.map((e) => e.path).join(', ');
        diagnostics.push({
          severity: 'warning',
          code: 'duplicate-element-name',
          message: `plugin ${kind} name "${name}" is defined more than once (${joined}); this may be one plugin installed at more than one path`,
          ...(pluginEntries[0] !== undefined ? { path: pluginEntries[0].path } : {}),
        });
      }
      continue;
    }

    const joined = entries.map((e) => e.path).join(', ');
    diagnostics.push({
      severity: 'warning',
      code: 'duplicate-element-name',
      ...(pluginOnly
        ? {
            message: `plugin ${kind} name "${name}" is defined more than once (${joined}); this may be one plugin installed at more than one path`,
          }
        : {
            message: `${kind} name "${name}" is defined more than once (${joined})`,
          }),
      ...(entries[0] !== undefined ? { path: entries[0].path } : {}),
    });
  }
}

export async function discoverClaudeCode(
  project: ProjectContext,
  access: AccessPolicy,
  home: string = homedir(),
  pathValue: string = process.env['PATH'] ?? '',
): Promise<ObservedSnapshot> {
  return collectClaudeCodeHarness(project, access, home, undefined, pathValue);
}

/**
 * The discovery core with an injected home and `PATH`, so tests need no global
 * state and no dependence on the machine. The managed base is a parameter so a
 * test injects a temp directory and never touches `/Library`; when it is omitted
 * the macOS-only default applies and a non-macOS host reads no managed scope.
 */
export async function collectClaudeCodeHarness(
  project: ProjectContext,
  access: AccessPolicy,
  home: string,
  managedDir?: string,
  pathValue: string = process.env['PATH'] ?? '',
): Promise<ObservedSnapshot> {
  const elements: ObservedElement[] = [];
  const diagnostics: Diagnostic[] = [];

  const detection = grants(access, 'install')
    ? await detectClaudeCode(home, pathValue)
    : {
        version: null,
        runtimeCompatibility: 'unverified' as const,
        diagnostics: [
          {
            severity: 'info' as const,
            code: 'consent-not-granted:install',
            message: 'installation and version metadata skipped: the install scope was not granted',
          },
        ],
      };
  diagnostics.push(...detection.diagnostics);

  await collectProject(project, elements, diagnostics);
  if (grants(access, 'user')) {
    await collectAncestorInstructions(project, elements, diagnostics);
    await collectUser(project, home, elements, diagnostics);
    const managed = managedConfigDirFor(process.platform, managedDir);
    if (managed !== null) {
      await collectManaged(managed, elements, diagnostics);
    }
  } else {
    // A missing user grant is a recorded absence, not an empty harness
    // (roadmap M8 #81).
    diagnostics.push({
      severity: 'info',
      code: 'consent-not-granted:user',
      message: 'user-scope discovery skipped: the user scope was not granted',
    });
  }
  elements.push(builtinLayer(RUNTIME_ID, '(builtin) claude-code instruction layers'));

  detectDuplicateNames(elements, diagnostics);

  return assembleObservedSnapshot({
    project: toObservedProject(project),
    runtime: { id: RUNTIME_ID, version: detection.version },
    adapter: {
      id: 'claude-code',
      version: packageVersion,
      runtimeCompatibility: detection.runtimeCompatibility,
    },
    elements,
    diagnostics,
    home,
  });
}

async function collectProject(
  project: ProjectContext,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const root = project.root;

  // One subtree walk finds the project-root instruction files and every nested
  // `CLAUDE.md` / `CLAUDE.local.md`, so a root file is never recorded twice.
  // `.git`, `node_modules`, and nested checkout boundaries are pruned, frontmatter
  // is not extracted (an instruction file is not a metadata carrier), and files
  // under the project config directory are excluded by path: a file there is
  // already discovered as a skill, and recording it here too would mint a second
  // element under the same id.
  await addWalkedArea(
    root,
    '.',
    '',
    'project',
    'project',
    instructionKindForPath,
    elements,
    diagnostics,
    {
      extractFrontmatter: false,
      selectFile: isProjectInstructionPath,
      pruneDirectories: PROJECT_WALK_PRUNE_DIRECTORIES,
      pruneNestedCheckouts: true,
    },
  );

  await addWalkedArea(
    root,
    PROJECT_CONFIG_DIR,
    '',
    'project',
    'project',
    kindForConfigPath,
    elements,
    diagnostics,
  );
  for (const file of SETTINGS_FILES) {
    await collectSettings(
      join(root, PROJECT_CONFIG_DIR, file),
      `${PROJECT_CONFIG_DIR}/${file}`,
      'project',
      'project',
      root,
      elements,
      diagnostics,
    );
  }
  await collectMcpFile(
    join(root, PROJECT_MCP_FILE),
    PROJECT_MCP_FILE,
    'project',
    'project',
    root,
    elements,
    diagnostics,
  );
}

/**
 * Claude Code reads `CLAUDE.md` from the project's parent directories, so the
 * walk starts at `dirname(project.root)` and climbs at most `MAX_ANCESTOR_DIRS`
 * levels. That is an out-of-project read: the caller gates the whole loop on
 * consent, reaching the filesystem root is the natural end, and hitting the
 * ceiling is recorded so a deeper project is visibly truncated rather than
 * silently missing its ancestors. Symlinked or hardlinked files are refused by
 * `addKnownFile`, like every other fixed read.
 */
async function collectAncestorInstructions(
  project: ProjectContext,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  let directory = dirname(project.root);
  for (let level = 1; level <= MAX_ANCESTOR_DIRS; level += 1) {
    const prefix = '../'.repeat(level);
    for (const file of PROJECT_INSTRUCTION_FILES) {
      await addKnownFile(
        join(directory, file),
        `${prefix}${file}`,
        'project',
        'project',
        'instructions',
        directory,
        elements,
        diagnostics,
      );
    }
    const parent = dirname(directory);
    if (parent === directory) return; // the filesystem root; nothing above it
    directory = parent;
  }
  diagnostics.push(
    limitExceededDiagnostic(
      'MAX_ANCESTOR_DIRS',
      MAX_ANCESTOR_DIRS,
      '../'.repeat(MAX_ANCESTOR_DIRS),
    ),
  );
}

/** The instruction kind a project-subtree file carries, or `null` to ignore it. */
function instructionKindForPath(relativePath: string): ClaudeCodeElementKind | null {
  const name = basename(relativePath);
  return name === 'CLAUDE.md' || name === 'CLAUDE.local.md' ? 'instructions' : null;
}

/**
 * Whether a project-subtree path is a project instruction candidate. The project
 * config directory is excluded by *path*, not by name: only `<project>/.claude`
 * is the config directory, and pruning every `.claude` directory would miss a
 * nested instruction file in a subdirectory that happens to share the name. Its
 * files are discovered by the `.claude/**` walk, so a `CLAUDE.md` inside it is a
 * skill file, not a second instruction element.
 */
function isProjectInstructionPath(relativePath: string): boolean {
  return (
    instructionKindForPath(relativePath) !== null &&
    !relativePath.startsWith(`${PROJECT_CONFIG_DIR}/`)
  );
}

/**
 * The managed scope is a system-wide, out-of-project read (`MANAGED_CONFIG_DIR`),
 * so the caller gates it on the same consent as the user scope. Only
 * `CLAUDE.md` and `settings.json` exist there: a managed `CLAUDE.local.md` or
 * `settings.local.json` has no meaning, so it is not read.
 */
async function collectManaged(
  managedDir: string,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const instruction = join(managedDir, USER_INSTRUCTION_FILE);
  await addKnownFile(
    instruction,
    instruction,
    'managed',
    'managed',
    'instructions',
    managedDir,
    elements,
    diagnostics,
  );
  const settings = join(managedDir, SETTINGS_FILES[0]);
  await collectSettings(
    settings,
    settings,
    'managed',
    'managed',
    managedDir,
    elements,
    diagnostics,
  );
}

/**
 * The managed config directory is a macOS convention (design doc §31.1), so the
 * default read is macOS-only. An explicit override (the injectable base) is read
 * on any platform, which is what lets the fixture test exercise the collection
 * hermetically without touching `/Library`. Pure and exported so the platform
 * gate is falsifiable in a unit test rather than only by a live `/Library` read.
 */
export function managedConfigDirFor(
  platform: NodeJS.Platform,
  override: string | undefined,
): string | null {
  if (override !== undefined) return override;
  return platform === 'darwin' ? MANAGED_CONFIG_DIR : null;
}

async function collectUser(
  project: ProjectContext,
  home: string,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const configDir = userConfigDir(home);
  await addKnownFile(
    join(configDir, USER_INSTRUCTION_FILE),
    `${USER_PREFIX}/${USER_INSTRUCTION_FILE}`,
    'user',
    'user',
    'instructions',
    configDir,
    elements,
    diagnostics,
  );
  for (const file of SETTINGS_FILES) {
    await collectSettings(
      join(configDir, file),
      `${USER_PREFIX}/${file}`,
      'user',
      'user',
      configDir,
      elements,
      diagnostics,
    );
  }
  for (const dir of USER_ELEMENT_DIRS) {
    await addWalkedArea(
      configDir,
      dir,
      USER_PREFIX,
      'user',
      'user',
      () => USER_DIR_KIND[dir],
      elements,
      diagnostics,
    );
  }
  await addWalkedArea(
    configDir,
    join(USER_PROJECTS_DIR, encodeProjectDir(project.root), 'memory'),
    USER_PREFIX,
    'user',
    'user',
    () => 'memory',
    elements,
    diagnostics,
  );
  await addWalkedArea(
    configDir,
    USER_PLUGINS_DIR,
    USER_PREFIX,
    'plugin',
    'user',
    kindForPluginPath,
    elements,
    diagnostics,
  );
  await collectMcpFile(
    join(home, '.claude.json'),
    '~/.claude.json',
    'user',
    'user',
    home,
    elements,
    diagnostics,
  );
}

interface WalkedAreaOptions {
  /**
   * Extract frontmatter metadata from each file's content. Element directories
   * (skills, agents, commands) want it; a project-wide instruction walk does
   * not, because it reads unrelated files and must not treat their content as
   * instructions.
   */
  extractFrontmatter?: boolean;
  /** Regular-file filter: only matching files are read and recorded. */
  selectFile?: (relativePath: string) => boolean;
  /** Directory names the walk must not descend into. */
  pruneDirectories?: readonly string[];
  /** Treat directories containing a `.git` entry as boundaries (issue #162). */
  pruneNestedCheckouts?: boolean;
}

async function addWalkedArea(
  root: string,
  subpath: string,
  displayPrefix: string,
  origin: NativeOrigin,
  scope: string,
  resolveKind: (relativePath: string) => ClaudeCodeElementKind | 'unknown' | null,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
  options: WalkedAreaOptions = {},
): Promise<void> {
  const walked = await walkHarnessPaths(root, [subpath], {
    ...(options.pruneDirectories !== undefined
      ? { pruneDirectories: options.pruneDirectories }
      : {}),
    ...(options.pruneNestedCheckouts !== undefined
      ? { pruneNestedCheckouts: options.pruneNestedCheckouts }
      : {}),
    ...(options.selectFile !== undefined ? { selectFile: options.selectFile } : {}),
    ...(options.extractFrontmatter === false
      ? {}
      : {
          describeFile: (relativePath: string, content: string) => {
            const kind = resolveKind(relativePath);
            if (kind === null || kind === 'unknown') return {};
            const displayPath = displayPrefix ? `${displayPrefix}/${relativePath}` : relativePath;
            const read = readFrontmatter(content);
            if (read.malformed) diagnostics.push(malformedFrontmatterDiagnostic(displayPath));
            return toSafeMetadata(frontmatterMetadata(read.facts));
          },
        }),
  });
  diagnostics.push(...walked.diagnostics);

  for (const entry of walked.entries) {
    if (entry.kind === 'directory') continue;
    const kind = resolveKind(entry.relativePath);
    if (kind === null) continue;

    const displayPath = displayPrefix
      ? `${displayPrefix}/${entry.relativePath}`
      : entry.relativePath;
    pushWalkedEntry({
      runtimeId: RUNTIME_ID,
      builders,
      entry,
      origin,
      scope,
      kind,
      displayPath,
      metadataForPath,
      elements,
      diagnostics,
      unsupported: kind === 'unknown',
    });
  }
}

function addKnownFile(
  absPath: string,
  displayPath: string,
  origin: NativeOrigin,
  scope: string,
  kind: ClaudeCodeElementKind,
  baseDir: string,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  return sharedAddKnownFile({
    runtimeId: RUNTIME_ID,
    builders,
    absPath,
    displayPath,
    origin,
    scope,
    kind,
    baseDir,
    metadataForPath,
    elements,
    diagnostics,
  });
}

async function collectSettings(
  absPath: string,
  displayPath: string,
  origin: NativeOrigin,
  scope: string,
  baseDir: string,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const read = await readTextFileGuarded(absPath, MAX_PARSE_BYTES, baseDir);
  if (read.status === 'missing') return;
  if (read.status === 'symlink') {
    elements.push(symlinkElement(origin, scope, 'settings', displayPath));
    return;
  }
  if (read.status === 'hardlink') {
    diagnostics.push(hardlinkDiagnostic(displayPath));
    elements.push(skippedElement(origin, scope, 'settings', displayPath, 'hardlink-not-followed'));
    return;
  }
  if (read.status === 'not-regular') {
    diagnostics.push(nonRegularDiagnostic(displayPath));
    elements.push(skippedNonRegularElement(origin, scope, 'settings', displayPath));
    return;
  }
  if (read.status === 'too-large') {
    diagnostics.push(limitExceededDiagnostic('MAX_PARSE_BYTES', read.maxBytes, displayPath));
    elements.push(skippedElement(origin, scope, 'settings', displayPath, 'limit-exceeded'));
    return;
  }
  if (read.status === 'unreadable') {
    diagnostics.push(unreadableDiagnostic(displayPath));
    elements.push(unreadableElement(origin, scope, 'settings', displayPath));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    diagnostics.push({
      severity: 'warning',
      code: 'invalid-settings',
      message: `could not parse ${displayPath}`,
      path: displayPath,
    });
    return;
  }
  if (!isRecord(parsed)) return;

  const permissions = parsed['permissions'];
  if (isRecord(permissions)) {
    elements.push(
      configElement(origin, scope, 'permissions', withFragment(displayPath, 'permissions'), {
        allowCount: arrayLength(permissions['allow']),
        denyCount: arrayLength(permissions['deny']),
        askCount: arrayLength(permissions['ask']),
      }),
    );
    // The runtime writes the approval mode under `permissions.defaultMode`;
    // there is no top-level `defaultMode`.
    if (typeof permissions['defaultMode'] === 'string') {
      elements.push(
        configElement(origin, scope, 'approval-policy', withFragment(displayPath, 'defaultMode'), {
          approvalPolicy: permissions['defaultMode'],
        }),
      );
    }
  }
  const hooks = parsed['hooks'];
  if (isRecord(hooks)) {
    const hookMatchers = matcherStrings(hooks);
    elements.push(
      configElement(origin, scope, 'hooks', withFragment(displayPath, 'hooks'), {
        eventNames: Object.keys(hooks),
        hookMatchers,
        hookMatcherCount: hookMatchers.length,
      }),
    );
  }
  if (typeof parsed['outputStyle'] === 'string') {
    elements.push(
      configElement(origin, scope, 'output-style', withFragment(displayPath, 'outputStyle'), {
        outputStyle: parsed['outputStyle'],
      }),
    );
  }
  const mcpServers = parsed['mcpServers'];
  if (isRecord(mcpServers)) {
    elements.push(
      configElement(origin, scope, 'mcp-configuration', withFragment(displayPath, 'mcpServers'), {
        serverNames: Object.keys(mcpServers),
      }),
    );
  }
  const enabledPlugins = parsed['enabledPlugins'];
  if (isRecord(enabledPlugins)) {
    elements.push(
      configElement(origin, scope, 'plugin', withFragment(displayPath, 'enabledPlugins'), {
        pluginNames: Object.keys(enabledPlugins),
        enabledPluginCount: Object.keys(enabledPlugins).length,
      }),
    );
  }
}

/**
 * The flat list of hook matcher strings in a `hooks` object, across every event.
 * Only the matcher is structural enough to persist: a matcher is a tool name or
 * an event pattern (`startup|resume|compact`, `Bash`), whereas a hook command,
 * its type, and its timeout are never recorded. A matcher-less entry (the
 * runtime allows `{ hooks: [...] }`) contributes nothing.
 */
function matcherStrings(hooks: Record<string, unknown>): string[] {
  const matchers: string[] = [];
  for (const value of Object.values(hooks)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (!isRecord(entry)) continue;
      const matcher = entry['matcher'];
      if (typeof matcher === 'string') matchers.push(matcher);
    }
  }
  return matchers;
}

/**
 * Reads an MCP configuration file and records its server *names* only. The
 * canonical project file (`.mcp.json`) and the user file (`~/.claude.json`) share
 * this guarded read, so a symlink, hardlink, non-regular file, oversized file,
 * or an unreadable one is surfaced with its reason exactly as a settings file is.
 * A server command, argument, or environment value is never persisted.
 */
async function collectMcpFile(
  absPath: string,
  displayPath: string,
  origin: NativeOrigin,
  scope: string,
  baseDir: string,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const read = await readTextFileGuarded(absPath, MAX_PARSE_BYTES, baseDir);
  if (read.status === 'missing') return;
  if (read.status === 'symlink') {
    elements.push(symlinkElement(origin, scope, 'mcp-configuration', displayPath));
    return;
  }
  if (read.status === 'hardlink') {
    diagnostics.push(hardlinkDiagnostic(displayPath));
    elements.push(
      skippedElement(origin, scope, 'mcp-configuration', displayPath, 'hardlink-not-followed'),
    );
    return;
  }
  if (read.status === 'not-regular') {
    diagnostics.push(nonRegularDiagnostic(displayPath));
    elements.push(skippedNonRegularElement(origin, scope, 'mcp-configuration', displayPath));
    return;
  }
  if (read.status === 'too-large') {
    diagnostics.push(limitExceededDiagnostic('MAX_PARSE_BYTES', read.maxBytes, displayPath));
    elements.push(
      skippedElement(origin, scope, 'mcp-configuration', displayPath, 'limit-exceeded'),
    );
    return;
  }
  if (read.status === 'unreadable') {
    diagnostics.push(unreadableDiagnostic(displayPath));
    elements.push(unreadableElement(origin, scope, 'mcp-configuration', displayPath));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    diagnostics.push({
      severity: 'warning',
      code: 'invalid-mcp-config',
      message: `could not parse ${displayPath}`,
      path: displayPath,
    });
    return;
  }
  if (!isRecord(parsed)) return;
  const mcpServers = parsed['mcpServers'];
  if (isRecord(mcpServers)) {
    elements.push(
      configElement(origin, scope, 'mcp-configuration', withFragment(displayPath, 'mcpServers'), {
        serverNames: Object.keys(mcpServers),
      }),
    );
  }
}

function kindForConfigPath(relativePath: string): ClaudeCodeElementKind | 'unknown' | null {
  const path = relativePath.startsWith(`${PROJECT_CONFIG_DIR}/`)
    ? relativePath.slice(PROJECT_CONFIG_DIR.length + 1)
    : relativePath;
  const top = path.split('/')[0] ?? '';
  switch (top) {
    case 'skills':
      return 'skills';
    case 'agents':
      return 'subagents';
    case 'commands':
      return 'commands';
    case 'rules':
      return 'rules';
    case 'output-styles':
      return 'output-style';
    case 'hooks':
      return 'hooks';
    case 'settings.json':
    case 'settings.local.json':
      return null; // handled as structural config elements
    default:
      return 'unknown';
  }
}

function kindForPluginPath(relativePath: string): ClaudeCodeElementKind {
  for (const segment of relativePath.split('/')) {
    const kind = PLUGIN_KIND_BY_DIR[segment];
    if (kind) return kind;
  }
  return 'plugin';
}

function configElement(
  origin: NativeOrigin,
  scope: string,
  kind: ClaudeCodeElementKind,
  path: string,
  raw: Record<string, SafeMetadataValue>,
): ObservedElement {
  return buildObservedElement({
    runtimeId: RUNTIME_ID,
    origin,
    scope,
    kind,
    path,
    metadata: toSafeMetadata(raw),
  });
}

function metadataForPath(displayPath: string): Record<string, SafeMetadataValue> {
  const name = basename(displayPath);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return {};
  return toSafeMetadata({ format: name.slice(dot + 1).toLowerCase() });
}

/** Applies the adapter allowlist and the redaction policy to metadata values. */
function toSafeMetadata(raw: Record<string, SafeMetadataValue>): Record<string, SafeMetadataValue> {
  const redacted: Record<string, SafeMetadataValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    redacted[key] = redactValue(value);
  }
  return filterToAllowlist(redacted, CLAUDE_CODE_SAFE_METADATA_ALLOWLIST);
}

function redactValue(value: SafeMetadataValue): SafeMetadataValue {
  if (typeof value === 'string') return redactClaudeCode(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
  if (value !== null && typeof value === 'object') {
    const result: Record<string, SafeMetadataValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = redactValue(nested);
    }
    return result;
  }
  return value;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Compile-time guard (roadmap M9 #131). If any builder helper's `kind` widens
 * back to `string`, this becomes `never`, and the assertion in the test fails.
 * The `@ts-expect-error` test pins the kind union; this pins the helpers that
 * use it, which the union alone does not (a helper could be retyped to `string`
 * while the union stayed narrow).
 */
type KindParams =
  | Parameters<typeof symlinkElement>[2]
  | Parameters<typeof unreadableElement>[2]
  | Parameters<typeof skippedElement>[2]
  | Parameters<typeof skippedNonRegularElement>[2];
export type AssertKindsNarrow = string extends KindParams ? never : true;
