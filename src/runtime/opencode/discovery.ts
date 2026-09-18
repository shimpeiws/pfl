import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { assembleObservedSnapshot } from '../../discovery/assemble.js';
import { frontmatterMetadata, readFrontmatter } from '../../discovery/frontmatter.js';
import { filterToAllowlist } from '../../discovery/metadata.js';
import { buildObservedElement } from '../../discovery/observed-element.js';
import { walkHarnessPaths, type DiscoveredPath } from '../../discovery/walk.js';
import type { Diagnostic } from '../../core/diagnostics.js';
import { fragmentKeyOf, withFragment } from '../../core/element-path.js';
import { runtimeId } from '../../core/ids.js';
import type {
  NativeOrigin,
  ObservedElement,
  ObservedSnapshot,
  SafeMetadataValue,
} from '../../core/observed.js';
import { MAX_ANCESTOR_DIRS, MAX_PARSE_BYTES, limitExceededDiagnostic } from '../../limits.js';
import { inspectFileTarget, readTextFileGuarded } from '../../util/fs.js';
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
import { detectOpencode } from './detect.js';
import { readJsonc } from './jsonc.js';
import { OPENCODE_SAFE_METADATA_ALLOWLIST } from './metadata.js';
import { redactOpencode } from './redact.js';
import {
  CONFIG_FILE_NAMES,
  ELEMENT_DIRS,
  INSTRUCTION_FALLBACK_FILE,
  MANAGED_CONFIG_DIR,
  PROJECT_COMPAT_SKILL_DIRS,
  PROJECT_CONFIG_DIR,
  PROJECT_WALK_PRUNE_DIRECTORIES,
  USER_CLAUDE_INSTRUCTION_FILE,
  USER_COMPAT_SKILL_DIRS,
  USER_INSTRUCTION_FILE,
  UNKNOWN_ELEMENT_KIND,
  userConfigDir,
  type ElementDirSpec,
  type OpenCodeElementKind,
  type OpenCodeRecordedKind,
} from './paths.js';

/**
 * Discovers the OpenCode harness and builds an immutable ObservedSnapshot (model
 * doc, issues #78, #93). Static only: configuration is read as text and never
 * evaluated, symlinks are never followed, declared targets are never opened, and
 * user-scope paths are opened only when `access` allows it.
 *
 * The model doc is authoritative and version-pinned. Two limits it states are
 * carried as diagnostics rather than hidden: the adapter models the default
 * on-disk layout and does not read the `OPENCODE_CONFIG*` environment
 * redirectors (§5.3), and the managed, MDM, and remote layers are `[upstream]`
 * and unexercised (§0), so they are recorded opaque rather than guessed.
 */

const RUNTIME_ID = runtimeId('opencode');
const USER_PREFIX = '~/.config/opencode';
const HOME_CLAUDE_PREFIX = '~/.claude';

// The shared element builders, parameterised by this adapter's kind union so a
// misspelled kind is a compile error (roadmap M9 #90, #131).
const builders = createElementBuilders<OpenCodeRecordedKind>(RUNTIME_ID);
const { symlinkElement, unreadableElement, skippedElement, skippedNonRegularElement } = builders;

/**
 * Ceiling on the number of elements one configuration key contributes. The file
 * itself is bounded by `MAX_PARSE_BYTES`, but a hostile 1 MiB document can
 * declare tens of thousands of keys; capping keeps one file from flooding the
 * snapshot. Hitting it is a diagnostic, never a silent truncation.
 */
const MAX_CONFIG_ITEMS = 256;

/**
 * Per-string ceiling on a persisted metadata value. The element and name counts
 * are capped; a single value read from a config file is not otherwise bounded
 * below the whole-file limit, so an allowlisted name cannot carry up to
 * `MAX_PARSE_BYTES` of arbitrary text into the store.
 */
const MAX_METADATA_STRING = 256;

/** Config keys the adapter models directly (everything else is unsupported). */
const MODELLED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'mcp',
  'permission',
  'model',
  'small_model',
  'provider',
  'disabled_providers',
  'enabled_providers',
  'compaction',
  'tool_output',
  'shell',
  'formatter',
  'lsp',
  'plugin',
  'tools',
  'instructions',
  'references',
  'skills',
  'agent',
  'mode',
  'command',
  'share',
  'snapshot',
  'autoupdate',
  'default_agent',
  'subagent_depth',
  'watcher',
  'username',
]);

/** Project-configuration scalar keys (model doc §7). */
const PROJECT_SCALAR_KEYS = [
  'share',
  'snapshot',
  'autoupdate',
  'default_agent',
  'subagent_depth',
  'watcher',
  'username',
] as const;

/** The kinds that form a named catalog, where a cross-scope collision is possible. */
const CATALOG_KINDS: ReadonlySet<string> = new Set(['skills', 'subagents', 'agents', 'commands']);

export async function discoverOpencode(
  project: ProjectContext,
  access: AccessPolicy,
  home: string = homedir(),
  pathValue: string = process.env['PATH'] ?? '',
): Promise<ObservedSnapshot> {
  return collectOpencodeHarness(project, access, home, undefined, pathValue);
}

/**
 * The discovery core with an injected home and `PATH`, so tests need no global
 * state and no dependence on the machine. The managed base is injected so a test
 * never touches `/Library`; when omitted, the macOS-only default applies and a
 * non-macOS host reads no managed file.
 */
export async function collectOpencodeHarness(
  project: ProjectContext,
  access: AccessPolicy,
  home: string,
  managedDir?: string,
  pathValue: string = process.env['PATH'] ?? '',
): Promise<ObservedSnapshot> {
  const elements: ObservedElement[] = [];
  const diagnostics: Diagnostic[] = [];

  const detection = grants(access, 'install')
    ? await detectOpencode(home, pathValue)
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

  // §9 of the model doc requires the default-layout limit to be visible.
  diagnostics.push(defaultLayoutNote());

  await collectProject(project, elements, diagnostics);
  if (grants(access, 'user')) {
    await collectAncestorInstructions(project, elements, diagnostics);
    await collectUser(home, elements, diagnostics);
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
  // The remote-org and MDM layers are recorded as opacity, not read, so consent
  // does not gate them: consent covers reads, and these perform none (model doc
  // §5, §9).
  elements.push(remoteOrgLayer());
  // The MDM layer accompanies the managed base: the macOS default, or an
  // injected base standing in for it in a test.
  if (managedConfigDirFor(process.platform, managedDir) !== null) {
    elements.push(mdmPreferencesLayer());
  }
  elements.push(builtinLayer(RUNTIME_ID, '(builtin) opencode instruction layers'));

  // A name collision is a diagnostic, not a resolution input: the model doc
  // measured no stable tie-break (model doc §6), so nothing depends on a winner.
  detectDuplicateNames(elements, diagnostics);

  return assembleObservedSnapshot({
    project: toObservedProject(project),
    runtime: { id: RUNTIME_ID, version: detection.version },
    adapter: {
      id: 'opencode',
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

  // Project instructions: AGENTS.md (fallback CLAUDE.md) at the root and in
  // nested directories. `.git` and `node_modules` are pruned, and the project
  // config directory is excluded by path so its files stay the `.opencode/**`
  // walk's elements.
  await addInstructionTree(root, elements, diagnostics);

  // Project configuration: the project's own `opencode.json[c]`, then the
  // `.opencode/opencode.json[c]` beside the element directories (model doc §2).
  await noteAmbiguousConfigForm(root, '', diagnostics);
  await noteAmbiguousConfigForm(join(root, PROJECT_CONFIG_DIR), PROJECT_CONFIG_DIR, diagnostics);
  for (const file of CONFIG_FILE_NAMES) {
    await collectConfigFile(
      join(root, file),
      file,
      'project',
      'project',
      root,
      elements,
      diagnostics,
    );
    await collectConfigFile(
      join(root, PROJECT_CONFIG_DIR, file),
      `${PROJECT_CONFIG_DIR}/${file}`,
      'project',
      'project',
      join(root, PROJECT_CONFIG_DIR),
      elements,
      diagnostics,
    );
  }

  await collectElementDirs(
    join(root, PROJECT_CONFIG_DIR),
    PROJECT_CONFIG_DIR,
    'project',
    'project',
    elements,
    diagnostics,
  );

  // Cross-runtime skills OpenCode loads directly from the project (model doc §4.2).
  await collectCompatSkills(root, PROJECT_COMPAT_SKILL_DIRS, '', 'project', elements, diagnostics);
}

/**
 * OpenCode reads `AGENTS.md` (fallback `CLAUDE.md`) from the project's parent
 * directories, so the walk starts at `dirname(project.root)` and climbs at most
 * `MAX_ANCESTOR_DIRS` levels. That is an out-of-project read: the caller gates
 * the whole loop on consent, reaching the filesystem root is the natural end, and
 * hitting the ceiling is recorded so a deeper project is visibly truncated rather
 * than silently missing its ancestors.
 */
async function collectAncestorInstructions(
  project: ProjectContext,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  let directory = dirname(project.root);
  for (let level = 1; level <= MAX_ANCESTOR_DIRS; level += 1) {
    const prefix = '../'.repeat(level);
    await collectInstructionInDir(directory, prefix, 'project', 'project', elements, diagnostics);
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

async function collectUser(
  home: string,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const configDir = userConfigDir(home);

  // The user instruction is `~/.config/opencode/AGENTS.md`, with
  // `~/.claude/CLAUDE.md` as the fallback (model doc §4.1). The fallback lives in
  // a different directory, so the same-directory helper does not apply.
  const agents = await inspectFileTarget(join(configDir, USER_INSTRUCTION_FILE), configDir);
  if (agents.status === 'missing') {
    await addKnownFile(
      join(home, USER_CLAUDE_INSTRUCTION_FILE),
      `${HOME_CLAUDE_PREFIX}/${INSTRUCTION_FALLBACK_FILE}`,
      'user',
      'claude-compat',
      'instructions',
      join(home, '.claude'),
      elements,
      diagnostics,
    );
  } else {
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
  }

  await noteAmbiguousConfigForm(configDir, USER_PREFIX, diagnostics);
  for (const file of CONFIG_FILE_NAMES) {
    await collectConfigFile(
      join(configDir, file),
      `${USER_PREFIX}/${file}`,
      'user',
      'user',
      configDir,
      elements,
      diagnostics,
    );
  }

  await collectElementDirs(configDir, USER_PREFIX, 'user', 'user', elements, diagnostics);
  await collectCompatSkills(home, USER_COMPAT_SKILL_DIRS, '~', 'user', elements, diagnostics);
}

/**
 * The managed scope is a system-wide, out-of-project read (model doc §2 #7), so
 * the caller gates it on the same consent as the user scope. Only the config file
 * exists there through a route `pfl` reads; a plist is not parsed, so the MDM
 * layer is recorded opaque by `mdmPreferencesLayer` instead.
 */
async function collectManaged(
  managedDir: string,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  for (const file of CONFIG_FILE_NAMES) {
    await collectConfigFile(
      join(managedDir, file),
      join(managedDir, file),
      'managed',
      'managed-file',
      managedDir,
      elements,
      diagnostics,
    );
  }
  await noteAmbiguousConfigForm(managedDir, managedDir, diagnostics);
}

/** macOS managed-scope directory, or null when the platform has none (mirrors Claude Code). */
export function managedConfigDirFor(
  platform: NodeJS.Platform,
  override: string | undefined,
): string | null {
  if (override !== undefined) return override;
  return platform === 'darwin' ? MANAGED_CONFIG_DIR : null;
}

/**
 * The project instruction walk. `AGENTS.md` and its `CLAUDE.md` fallback are
 * read from the root and nested directories; the fallback is suppressed in a
 * directory that also holds `AGENTS.md` (model doc §4.1). `.opencode/**` is
 * excluded by path so a config-dir file is never a second instruction element.
 */
async function addInstructionTree(
  root: string,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const walked = await walkHarnessPaths(root, ['.'], {
    pruneDirectories: PROJECT_WALK_PRUNE_DIRECTORIES,
    selectFile: isProjectInstructionPath,
  });
  diagnostics.push(...walked.diagnostics);

  const agentsDirs = new Set<string>();
  for (const entry of walked.entries) {
    if (basename(entry.relativePath) === 'AGENTS.md') agentsDirs.add(dirname(entry.relativePath));
  }

  for (const entry of walked.entries) {
    if (entry.kind === 'directory') continue;
    // `selectFile` is applied to regular files inside the walk, but a symlink or
    // non-regular entry is recorded without that filter, so the candidate check
    // is repeated here for every entry kind. Without it a symlink anywhere in
    // the project would be recorded as an instruction element.
    if (!isProjectInstructionPath(entry.relativePath)) continue;
    const name = basename(entry.relativePath);
    if (name === INSTRUCTION_FALLBACK_FILE && agentsDirs.has(dirname(entry.relativePath))) continue;
    pushWalkedEntry({
      runtimeId: RUNTIME_ID,
      builders,
      entry,
      origin: 'project',
      scope: 'project',
      kind: 'instructions',
      displayPath: entry.relativePath,
      metadataForPath,
      elements,
      diagnostics,
    });
  }
}

function isProjectInstructionPath(relativePath: string): boolean {
  const name = basename(relativePath);
  if (name !== 'AGENTS.md' && name !== INSTRUCTION_FALLBACK_FILE) return false;
  return !relativePath.startsWith(`${PROJECT_CONFIG_DIR}/`);
}

/**
 * Reads one ancestor directory's instruction file, honouring the `AGENTS.md` →
 * `CLAUDE.md` fallback. `displayPrefix` is the `../…` climb for the level. (The
 * project root's own files are handled by `addInstructionTree`, not here.)
 */
async function collectInstructionInDir(
  directory: string,
  displayPrefix: string,
  origin: NativeOrigin,
  scope: string,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const prefix =
    displayPrefix === '' ? '' : displayPrefix.endsWith('/') ? displayPrefix : `${displayPrefix}/`;
  const agents = await inspectFileTarget(join(directory, 'AGENTS.md'), directory);
  if (agents.status !== 'missing') {
    await addKnownFile(
      join(directory, 'AGENTS.md'),
      `${prefix}AGENTS.md`,
      origin,
      scope,
      'instructions',
      directory,
      elements,
      diagnostics,
    );
    return;
  }
  await addKnownFile(
    join(directory, INSTRUCTION_FALLBACK_FILE),
    `${prefix}${INSTRUCTION_FALLBACK_FILE}`,
    origin,
    scope,
    'instructions',
    directory,
    elements,
    diagnostics,
  );
}

/**
 * Records a warning when both `opencode.json` and `opencode.jsonc` exist in one
 * directory. The model doc accepts both spellings but does not establish which
 * OpenCode reads when both are present, so the adapter records both files and
 * surfaces the ambiguity rather than assuming a precedence.
 */
async function noteAmbiguousConfigForm(
  configDir: string,
  displayPrefix: string,
  diagnostics: Diagnostic[],
): Promise<void> {
  const present = await Promise.all(
    CONFIG_FILE_NAMES.map(async (file) => ({
      file,
      target: await inspectFileTarget(join(configDir, file), configDir),
    })),
  );
  const found = present.filter((entry) => entry.target.status === 'ok');
  if (found.length < 2) return;
  const names = found.map((entry) =>
    displayPrefix === '' ? entry.file : `${displayPrefix}/${entry.file}`,
  );
  diagnostics.push({
    severity: 'warning',
    code: 'ambiguous-config-form',
    message: `both ${names.join(' and ')} exist; which OpenCode reads is not established`,
    path: names[0] as string,
  });
}

/**
 * Reads one `opencode.json[c]` and records the config keys the adapter models as
 * elements. Invalid config is fatal in the runtime but only a diagnostic here
 * (model doc §2; best-effort invariant): the parse failure is visible and the
 * inspection does not abort.
 */
async function collectConfigFile(
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
    elements.push(symlinkElement(origin, scope, 'config', displayPath));
    return;
  }
  if (read.status === 'hardlink') {
    diagnostics.push(hardlinkDiagnostic(displayPath));
    elements.push(skippedElement(origin, scope, 'config', displayPath, 'hardlink-not-followed'));
    return;
  }
  if (read.status === 'not-regular') {
    diagnostics.push(nonRegularDiagnostic(displayPath));
    elements.push(skippedNonRegularElement(origin, scope, 'config', displayPath));
    return;
  }
  if (read.status === 'too-large') {
    diagnostics.push(limitExceededDiagnostic('MAX_PARSE_BYTES', read.maxBytes, displayPath));
    elements.push(skippedElement(origin, scope, 'config', displayPath, 'limit-exceeded'));
    return;
  }
  if (read.status === 'unreadable') {
    diagnostics.push(unreadableDiagnostic(displayPath));
    elements.push(unreadableElement(origin, scope, 'config', displayPath));
    return;
  }

  const parsed = readJsonc(read.text);
  if (parsed.malformed || !isRecord(parsed.value)) {
    diagnostics.push(invalidConfigDiagnostic(displayPath));
    return;
  }
  recordConfigElements(parsed.value, displayPath, origin, scope, elements, diagnostics);
}

function recordConfigElements(
  config: Record<string, unknown>,
  displayPath: string,
  origin: NativeOrigin,
  scope: string,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): void {
  const push = (
    kind: OpenCodeElementKind,
    fragment: string,
    raw: Record<string, SafeMetadataValue>,
  ): void => {
    elements.push(configElement(kind, withFragment(displayPath, fragment), raw, origin, scope));
  };

  const mcp = config['mcp'];
  if (isRecord(mcp)) {
    push('mcp-configuration', 'mcp', { serverNames: cappedKeys(mcp, displayPath, diagnostics) });
  }

  const permission = config['permission'];
  if (isRecord(permission)) {
    push('permissions', 'permission', permissionCounts(permission));
  }

  const modelConfig: Record<string, SafeMetadataValue> = {};
  if (typeof config['model'] === 'string') modelConfig['model'] = config['model'];
  if (typeof config['small_model'] === 'string') modelConfig['smallModel'] = config['small_model'];
  if (Object.keys(modelConfig).length > 0) push('model-configuration', 'model', modelConfig);

  const provider = config['provider'];
  if (isRecord(provider)) {
    push('model-configuration', 'provider', {
      providerNames: cappedKeys(provider, displayPath, diagnostics),
    });
  }
  if (Array.isArray(config['disabled_providers'])) {
    push('model-configuration', 'disabled_providers', {
      disabledProviderCount: config['disabled_providers'].length,
    });
  }
  if (Array.isArray(config['enabled_providers'])) {
    push('model-configuration', 'enabled_providers', {
      enabledProviderCount: config['enabled_providers'].length,
    });
  }

  if (isRecord(config['compaction'])) {
    push('compaction-controls', 'compaction', { compactionConfigured: true });
  }
  if (isRecord(config['tool_output'])) {
    push('compaction-controls', 'tool_output', { toolOutputConfigured: true });
  }

  if (isRecord(config['shell']) || typeof config['shell'] === 'string') {
    push('shell-environment', 'shell', { shellConfigured: true });
  }

  const toolingKeys: string[] = [];
  if (isRecord(config['formatter'])) toolingKeys.push('formatter');
  if (isRecord(config['lsp'])) toolingKeys.push('lsp');
  if (toolingKeys.length > 0) push('tooling-configuration', 'tooling', { toolingKeys });

  const plugin = config['plugin'];
  if (Array.isArray(plugin)) {
    if (plugin.length > MAX_CONFIG_ITEMS) {
      diagnostics.push(truncationDiagnostic(displayPath, 'plugin entries'));
    }
    const names: string[] = [];
    const targetKinds: string[] = [];
    for (const entry of plugin.slice(0, MAX_CONFIG_ITEMS)) {
      const identity = pluginIdentity(entry);
      if (identity.name !== undefined) names.push(identity.name);
      if (identity.kind !== undefined) targetKinds.push(identity.kind);
    }
    push('plugin', 'plugin', {
      pluginNames: names,
      pluginTargetKinds: targetKinds,
      pluginCount: plugin.length,
    });
  }

  const tools = config['tools'];
  if (isRecord(tools)) {
    push('tools', 'tools', { toolNames: cappedKeys(tools, displayPath, diagnostics) });
  }

  recordDeclaredTargets(
    config['instructions'],
    'instructions',
    displayPath,
    origin,
    scope,
    elements,
    diagnostics,
  );
  recordReferences(config['references'], displayPath, origin, scope, elements, diagnostics);
  recordSkillSources(config['skills'], displayPath, origin, scope, elements, diagnostics);

  recordInlineAgents(config, displayPath, origin, scope, elements, diagnostics);
  recordInlineCommands(config, displayPath, origin, scope, elements, diagnostics);

  const projectKeys = PROJECT_SCALAR_KEYS.filter((key) => config[key] !== undefined);
  if (projectKeys.length > 0) {
    push('project-configuration', 'project', { projectConfigKeys: [...projectKeys] });
  }

  // Every key the adapter does not model is recorded as unsupported rather than
  // dropped, so a new runtime key surfaces instead of disappearing. `$schema` is
  // a document pointer, not harness configuration, so it is not recorded. The
  // list is capped like every other element producer, so a hostile document with
  // tens of thousands of unknown keys cannot flood the snapshot.
  const unmodelled = Object.keys(config).filter(
    (key) => key !== '$schema' && !MODELLED_CONFIG_KEYS.has(key),
  );
  if (unmodelled.length > MAX_CONFIG_ITEMS) {
    diagnostics.push(truncationDiagnostic(displayPath, 'keys'));
  }
  for (const key of unmodelled.slice(0, MAX_CONFIG_ITEMS)) {
    elements.push(
      unsupportedConfigKey(withFragment(displayPath, capMetadataString(key)), origin, scope),
    );
  }
}

/** The inline `agent` map: an agent is a subagent unless `mode: primary`. */
function recordInlineAgents(
  config: Record<string, unknown>,
  displayPath: string,
  origin: NativeOrigin,
  scope: string,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): void {
  const agents = config['agent'];
  if (isRecord(agents)) {
    for (const [name, definition] of cappedEntries(agents, displayPath, diagnostics)) {
      const declaredMode =
        isRecord(definition) && typeof definition['mode'] === 'string'
          ? normalizeAgentMode(definition['mode'])
          : undefined;
      // A definition that does not declare a mode is recorded conservatively as
      // a subagent, and `agentMode` is only persisted when it was declared.
      const kind: OpenCodeElementKind = declaredMode === 'primary' ? 'agents' : 'subagents';
      elements.push(
        configElement(
          kind,
          withFragment(displayPath, capMetadataString(`agent.${name}`)),
          declaredMode !== undefined ? { agentMode: declaredMode } : {},
          origin,
          scope,
        ),
      );
    }
  }
  // The legacy `mode` map is not modelled as agents (model doc §4.1, §7).
  const legacy = config['mode'];
  if (isRecord(legacy)) {
    for (const [name] of cappedEntries(legacy, displayPath, diagnostics)) {
      elements.push(
        unsupportedConfigKey(
          withFragment(displayPath, capMetadataString(`mode.${name}`)),
          origin,
          scope,
        ),
      );
    }
  }
}

function recordInlineCommands(
  config: Record<string, unknown>,
  displayPath: string,
  origin: NativeOrigin,
  scope: string,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): void {
  const commands = config['command'];
  if (!isRecord(commands)) return;
  for (const [name] of cappedEntries(commands, displayPath, diagnostics)) {
    elements.push(
      configElement(
        'commands',
        withFragment(displayPath, capMetadataString(`command.${name}`)),
        {},
        origin,
        scope,
      ),
    );
  }
}

/**
 * Records the `instructions` array. The target is never opened and never
 * persisted: only its *kind* (path, glob, URL, absolute path) is structural
 * enough to store, so a credential-bearing URL cannot reach the snapshot through
 * the declaration (model doc §5.2).
 */
function recordDeclaredTargets(
  value: unknown,
  kind: 'instructions',
  displayPath: string,
  origin: NativeOrigin,
  scope: string,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): void {
  if (value === undefined) return;
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length > MAX_CONFIG_ITEMS) {
    diagnostics.push(truncationDiagnostic(displayPath, `${kind} targets`));
  }
  entries.slice(0, MAX_CONFIG_ITEMS).forEach((entry, index) => {
    const path = withFragment(displayPath, `${kind}.${index}`);
    if (typeof entry !== 'string') {
      // A non-string declaration is recorded rather than dropped, so a shape the
      // adapter does not model is visible (best-effort invariant).
      elements.push(unsupportedConfigKey(path, origin, scope));
      return;
    }
    elements.push(declaredElement(kind, path, referencePathKind(entry), origin, scope));
  });
}

/**
 * Records the `references` object (model doc §12; #150). On 1.18.31 `references`
 * is an object keyed by alias, each value `{ path }` or `{ repository, branch }`
 * (plus optional `description`/`hidden`), or a string shorthand. Every alias is
 * recorded as one opaque declaration; the target is never opened and only its
 * kind is persisted. An array — which the runtime rejects as invalid config — is
 * recorded as an unsupported declaration rather than dropped.
 */
function recordReferences(
  value: unknown,
  displayPath: string,
  origin: NativeOrigin,
  scope: string,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    elements.push(unsupportedConfigKey(withFragment(displayPath, 'references'), origin, scope));
    return;
  }
  for (const [index, [alias, target]] of cappedEntries(value, displayPath, diagnostics).entries()) {
    elements.push(
      declaredElement(
        'references',
        // The index keeps the path unique even if two long aliases truncate to
        // the same prefix; the alias is carried for readability.
        withFragment(displayPath, capMetadataString(`references.${index}.${alias}`)),
        referenceTargetKind(target),
        origin,
        scope,
      ),
    );
  }
}

/**
 * Records the `skills` config key's declared sources (model doc §12; #151):
 * `skills.paths` (directories/globs) and `skills.urls`. They are declarations
 * `pfl` never opens, so each becomes an opaque `skills` element carrying only a
 * derived kind.
 */
function recordSkillSources(
  value: unknown,
  displayPath: string,
  origin: NativeOrigin,
  scope: string,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    elements.push(unsupportedConfigKey(withFragment(displayPath, 'skills'), origin, scope));
    return;
  }
  for (const [index, [key, list]] of cappedEntries(value, displayPath, diagnostics).entries()) {
    // Any sub-key the adapter does not model — including a `paths`/`urls` that
    // is not an array — is recorded rather than dropped, so adding `skills` to
    // the modelled keys does not remove the visibility the unknown-key sweep
    // used to give (best-effort invariant). The index keeps an arbitrary
    // sub-key's fragment unique after truncation.
    if (key !== 'paths' && key !== 'urls') {
      elements.push(
        unsupportedConfigKey(
          withFragment(displayPath, capMetadataString(`skills.${index}.${key}`)),
          origin,
          scope,
        ),
      );
      continue;
    }
    if (!Array.isArray(list)) {
      elements.push(
        unsupportedConfigKey(withFragment(displayPath, `skills.${key}`), origin, scope),
      );
      continue;
    }
    if (list.length > MAX_CONFIG_ITEMS) {
      diagnostics.push(truncationDiagnostic(displayPath, `skills.${key} targets`));
    }
    list.slice(0, MAX_CONFIG_ITEMS).forEach((entry, index) => {
      const path = withFragment(displayPath, `skills.${key}.${index}`);
      if (typeof entry !== 'string') {
        elements.push(unsupportedConfigKey(path, origin, scope));
        return;
      }
      // A `urls` entry is necessarily a URL; a `paths` entry is a path or glob.
      const kind = key === 'urls' ? 'url' : referencePathKind(entry);
      elements.push(declaredElement('skills', path, kind, origin, scope));
    });
  }
}

/** An opaque declaration element: the kind is stored, the target is not. */
function declaredElement(
  kind: OpenCodeElementKind,
  path: string,
  declaredKind: string,
  origin: NativeOrigin,
  scope: string,
): ObservedElement {
  return buildObservedElement({
    runtimeId: RUNTIME_ID,
    origin,
    scope,
    kind,
    path,
    inspectability: 'opaque',
    metadata: toSafeMetadata({ declaredTargetKind: declaredKind }),
  });
}

/** A `references` entry's kind. The object form's own key decides the family. */
function referenceTargetKind(target: unknown): string {
  if (typeof target === 'string') return referenceStringKind(target);
  if (isRecord(target)) {
    // `{ "path": … }` is explicitly a path, so it is never classified as a
    // repository: a relative directory such as `docs/refs` is a path, not an
    // `owner/repo` shorthand.
    if (typeof target['path'] === 'string') return referencePathKind(target['path']);
    if (typeof target['repository'] === 'string') return 'repository';
  }
  return 'other';
}

/** A path value's kind: path, glob, absolute path, or URL — never a repository. */
function referencePathKind(value: string): string {
  const trimmed = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return 'url';
  if (/[*?[]/.test(trimmed)) return 'glob';
  if (trimmed.startsWith('/')) return 'absolute-path';
  return 'path';
}

/**
 * A string shorthand is a local path or a Git repository. Git shapes: a `.git`
 * suffix, an `owner/repo` shorthand (one separator, no leading `.`/`~`), a
 * host-prefixed `host.tld/owner/repo`, or an scp-like `user@host:path`.
 */
function referenceStringKind(value: string): string {
  const trimmed = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return 'url';
  if (/[*?[]/.test(trimmed)) return 'glob';
  if (trimmed.startsWith('/')) return 'absolute-path';
  if (/\.git\/?$/.test(trimmed)) return 'repository';
  if (/^[^@\s]+@[^:\s]+:[^:\s]+$/.test(trimmed)) return 'repository';
  if (/^[a-z0-9.-]+\.[a-z]{2,}\/[^/\s]+\/[^/\s]+$/i.test(trimmed)) return 'repository';
  if (/^[^./~\s][^/\s]*\/[^/\s]+$/.test(trimmed)) return 'repository';
  return 'path';
}

function permissionCounts(permission: Record<string, unknown>): Record<string, SafeMetadataValue> {
  let allowCount = 0;
  let askCount = 0;
  let denyCount = 0;
  for (const value of Object.values(permission)) {
    if (value === 'allow') allowCount += 1;
    else if (value === 'ask') askCount += 1;
    else if (value === 'deny') denyCount += 1;
    else if (isRecord(value)) {
      // A per-tool pattern object: count each decision inside it.
      for (const decision of Object.values(value)) {
        if (decision === 'allow') allowCount += 1;
        else if (decision === 'ask') askCount += 1;
        else if (decision === 'deny') denyCount += 1;
      }
    }
  }
  return {
    allowCount,
    askCount,
    denyCount,
    // Counts top-level `permission` keys, not the decisions: a per-pattern object
    // contributes several decisions under one key, so the two figures differ.
    topLevelRuleCount: Object.keys(permission).length,
  };
}

/**
 * Walks every element directory in one scope. Skills hold `<name>/SKILL.md`;
 * every other surface holds files directly. The legacy `mode(s)/` directory is
 * recorded as unsupported rather than classified as agents.
 */
async function collectElementDirs(
  base: string,
  displayPrefix: string,
  origin: NativeOrigin,
  scope: string,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  for (const spec of ELEMENT_DIRS) {
    for (const dir of spec.dirs) {
      await collectElementDir(base, dir, displayPrefix, origin, scope, spec, elements, diagnostics);
    }
  }
}

async function collectElementDir(
  base: string,
  dir: string,
  displayPrefix: string,
  origin: NativeOrigin,
  scope: string,
  spec: ElementDirSpec,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const walked = await walkHarnessPaths(base, [dir], {
    selectFile: (relativePath) => spec.selectFile(relativePath),
    ...(spec.extractFrontmatter
      ? {
          describeFile: (relativePath: string, content: string) => {
            const displayPath = joinDisplay(displayPrefix, relativePath);
            const read = readFrontmatter(content);
            if (read.malformed) diagnostics.push(malformedFrontmatterDiagnostic(displayPath));
            const metadata: Record<string, SafeMetadataValue> = {
              ...frontmatterMetadata(read.facts),
            };
            // Only a well-formed block contributes a mode; a malformed block
            // must not change the element's kind, so it falls to the
            // conservative `subagents` default (see `kindForEntry`).
            if (spec.kind === 'subagents' && !read.malformed) {
              const mode = frontmatterMode(content);
              if (mode !== undefined) metadata['agentMode'] = normalizeAgentMode(mode);
            }
            return toSafeMetadata(metadata);
          },
        }
      : {}),
  });
  diagnostics.push(...walked.diagnostics);

  for (const entry of walked.entries) {
    if (entry.kind === 'directory') continue;
    const kind = kindForEntry(spec, entry);
    if (kind === undefined) continue;
    const displayPath = joinDisplay(displayPrefix, entry.relativePath);
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
    });
  }
}

/**
 * The cross-runtime skill roots OpenCode loads from the project or the home
 * (model doc §4.2, §4.1). The scope string carries the cross-runtime provenance;
 * the origin stays the declaring scope's.
 */
async function collectCompatSkills(
  base: string,
  dirs: readonly string[],
  displayPrefix: string,
  origin: NativeOrigin,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const spec: ElementDirSpec = {
    dirs: [],
    kind: 'skills',
    extractFrontmatter: true,
    selectFile: isSkillFile,
  };
  for (const dir of dirs) {
    const dirScope = dir.startsWith('.agents') ? 'agents-compat' : 'claude-compat';
    await collectElementDir(
      base,
      dir,
      displayPrefix,
      origin,
      dirScope,
      spec,
      elements,
      diagnostics,
    );
  }
}

function isSkillFile(relativePath: string): boolean {
  const segments = relativePath.split('/');
  return segments.length >= 2 && segments[segments.length - 1] === 'SKILL.md';
}

function kindForEntry(
  spec: ElementDirSpec,
  entry: DiscoveredPath,
): OpenCodeElementKind | undefined {
  // The filter is repeated here because a symlink or non-regular entry is
  // recorded by the walk without running `selectFile`; without this a symlink
  // of any name would be recorded as the directory's kind.
  if (!spec.selectFile(entry.relativePath)) return undefined;
  if (spec.kind === 'subagents') {
    const declared = entry.metadata?.['agentMode'];
    const mode = typeof declared === 'string' ? declared : (spec.defaultAgentMode ?? 'subagent');
    // `all` is not `primary`, so it stays in the conservative subagent bucket.
    return mode === 'primary' ? 'agents' : 'subagents';
  }
  return spec.kind;
}

/** Narrows an agent `mode` to the values the adapter models; anything else is `other`. */
function normalizeAgentMode(mode: string): string {
  const value = mode.trim().toLowerCase();
  if (value === 'primary') return 'primary';
  if (value === 'subagent') return 'subagent';
  return 'other';
}

/** The `mode:` line of the leading frontmatter block. */
const FRONTMATTER_MODE = /^mode\s*:\s*(.+?)\s*$/;

/** Reads the top-level frontmatter `mode` value, or undefined. */
function frontmatterMode(content: string): string | undefined {
  const bounded = content.length > MAX_PARSE_BYTES ? content.slice(0, MAX_PARSE_BYTES) : content;
  // Match the shared reader's BOM handling so the two agree on where the block
  // starts; a divergence would change an element's kind, not just its metadata.
  const text = bounded.charCodeAt(0) === 0xfeff ? bounded.slice(1) : bounded;
  const lines = text.split(/\r?\n/);
  if (!/^---\s*$/.test(lines[0] ?? '')) return undefined;
  const close = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
  const body = close === -1 ? lines.slice(1) : lines.slice(1, close);
  for (const line of body) {
    if (/^\s/.test(line)) continue;
    const match = FRONTMATTER_MODE.exec(line);
    if (match?.[1] !== undefined) return match[1].replace(/^["']|["']$/g, '');
  }
  return undefined;
}

/**
 * Emits one diagnostic per catalog name defined more than once. OpenCode emits a
 * single catalog entry and documents no tie-break, and the measured winner was
 * not stable across consecutive invocations (model doc §6), so the duplicate is
 * reported and no winner is depended on.
 */
function detectDuplicateNames(
  elements: readonly ObservedElement[],
  diagnostics: Diagnostic[],
): void {
  const byName = new Map<string, string[]>();
  for (const element of elements) {
    const identity = catalogIdentity(element);
    if (identity === null) continue;
    const key = `${identity.kind}\u0000${identity.name}`;
    const paths = byName.get(key) ?? [];
    paths.push(element.source.path ?? '');
    byName.set(key, paths);
  }

  for (const [key, paths] of byName) {
    if (paths.length <= 1) continue;
    const [kind, name] = key.split('\u0000') as [string, string];
    const first = paths[0];
    diagnostics.push({
      severity: 'warning',
      code: 'duplicate-element-name',
      message: `${kind} name "${name}" is defined more than once (${[...paths].sort().join(', ')}); the surviving copy is not deterministic`,
      ...(first !== undefined ? { path: first } : {}),
    });
  }
}

/** The catalog name an element contributes, when it is a named catalog entry. */
function catalogIdentity(element: ObservedElement): { kind: string; name: string } | null {
  // A skipped symlink or unreadable file is not a competing definition.
  if (element.status !== 'observed') return null;
  const kind = element.native.kind;
  if (!CATALOG_KINDS.has(kind)) return null;
  const path = element.source.path;
  if (path === undefined) return null;

  // `agents` and `subagents` share one OpenCode agent namespace; a primary and a
  // subagent of the same name collide even though pfl models different kinds.
  const namespace = kind === 'agents' || kind === 'subagents' ? 'agent' : kind;

  const fragment = fragmentKeyOf(path);
  if (fragment !== null) {
    if (fragment.startsWith('agent.')) {
      return { kind: namespace, name: fragment.slice('agent.'.length) };
    }
    if (fragment.startsWith('command.')) {
      return { kind: namespace, name: fragment.slice('command.'.length) };
    }
    return null;
  }
  if (path.endsWith('/SKILL.md')) {
    const segments = path.split('/');
    return { kind: namespace, name: segments[segments.length - 2] as string };
  }
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return { kind: namespace, name: dot > 0 ? name.slice(0, dot) : name };
}

function addKnownFile(
  absPath: string,
  displayPath: string,
  origin: NativeOrigin,
  scope: string,
  kind: OpenCodeElementKind | 'config',
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

function configElement(
  kind: OpenCodeElementKind,
  path: string,
  raw: Record<string, SafeMetadataValue>,
  origin: NativeOrigin,
  scope: string,
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

function unsupportedConfigKey(path: string, origin: NativeOrigin, scope: string): ObservedElement {
  return buildObservedElement({
    runtimeId: RUNTIME_ID,
    origin,
    scope,
    kind: UNKNOWN_ELEMENT_KIND,
    path,
    status: 'unsupported',
    reason: 'unsupported-by-adapter',
  });
}

/**
 * The remote organizational-defaults layer (model doc §5, §9). Its *provenance*
 * cannot be established statically — pfl cannot confirm it exists, is
 * authenticated, or is org-scoped — so the origin is `unknown` rather than
 * inferred, and `scope` plus `inspectability: 'opaque'` carry what is known.
 */
function remoteOrgLayer(): ObservedElement {
  return buildObservedElement({
    runtimeId: RUNTIME_ID,
    origin: 'unknown',
    scope: 'remote-org',
    kind: 'config',
    path: '(remote) .well-known/opencode org defaults',
    inspectability: 'opaque',
  });
}

/**
 * The macOS managed-preferences (MDM) layer is `[upstream]` and unexercised
 * (model doc §2 #8). `pfl` does not parse plists, so the layer is recorded
 * opaque rather than guessed.
 */
function mdmPreferencesLayer(): ObservedElement {
  return buildObservedElement({
    runtimeId: RUNTIME_ID,
    origin: 'managed',
    scope: 'managed-preferences',
    kind: 'config',
    path: '(managed) ai.opencode.managed preferences',
    inspectability: 'opaque',
  });
}

function defaultLayoutNote(): Diagnostic {
  return {
    severity: 'info',
    code: 'default-layout-only',
    message:
      'OpenCode configuration was read from the default on-disk layout; OPENCODE_CONFIG, OPENCODE_CONFIG_DIR, and OPENCODE_CONFIG_CONTENT are execution context and are not read (model doc §5.3)',
  };
}

function invalidConfigDiagnostic(displayPath: string): Diagnostic {
  return {
    severity: 'warning',
    code: 'invalid-config',
    message: `could not parse ${displayPath}`,
    path: displayPath,
  };
}

function cappedKeys(
  record: Record<string, unknown>,
  displayPath: string,
  diagnostics: Diagnostic[],
): string[] {
  const keys = Object.keys(record);
  if (keys.length > MAX_CONFIG_ITEMS) {
    diagnostics.push(truncationDiagnostic(displayPath, 'names'));
    return keys.slice(0, MAX_CONFIG_ITEMS);
  }
  return keys;
}

function cappedEntries(
  record: Record<string, unknown>,
  displayPath: string,
  diagnostics: Diagnostic[],
): [string, unknown][] {
  const entries = Object.entries(record);
  if (entries.length > MAX_CONFIG_ITEMS) {
    diagnostics.push(truncationDiagnostic(displayPath, 'entries'));
    return entries.slice(0, MAX_CONFIG_ITEMS);
  }
  return entries;
}

function truncationDiagnostic(displayPath: string, noun: string): Diagnostic {
  return {
    severity: 'warning',
    code: 'config-items-truncated',
    message: `${displayPath} declares more than ${MAX_CONFIG_ITEMS} ${noun}; only the first ${MAX_CONFIG_ITEMS} are recorded`,
    path: displayPath,
  };
}

/** A bare npm-style plugin specifier: `name` or `@scope/name`, no path or URL. */
const BARE_PACKAGE_SPECIFIER = /^(@[a-z0-9][a-z0-9-._~]*\/)?[a-z0-9][a-z0-9-._~]*$/i;

/**
 * A plugin entry's identity. Only a bare package specifier is persisted as a
 * name; a path or URL specifier is persisted as its kind instead, so an
 * author-controlled URL or filesystem path (which redaction cannot reliably
 * de-identify) never reaches the store as a value. A tuple's first member is
 * the specifier (model doc §4.1).
 */
function pluginIdentity(entry: unknown): { name?: string; kind?: string } {
  const raw =
    typeof entry === 'string'
      ? entry
      : Array.isArray(entry) && typeof entry[0] === 'string'
        ? (entry[0] as string)
        : undefined;
  if (raw === undefined) return {};
  if (BARE_PACKAGE_SPECIFIER.test(raw)) return { name: raw };
  // A non-bare specifier is a relative/absolute path or a `file://` URL — never
  // a repository — so the path-only classifier is used.
  return { kind: referencePathKind(raw) };
}

function capMetadataString(value: string): string {
  return value.length > MAX_METADATA_STRING ? `${value.slice(0, MAX_METADATA_STRING)}…` : value;
}

function joinDisplay(prefix: string, relativePath: string): string {
  if (prefix === '') return relativePath;
  if (prefix === '~') return `~/${relativePath}`;
  return `${prefix}/${relativePath}`;
}

function metadataForPath(displayPath: string): Record<string, SafeMetadataValue> {
  const name = basename(displayPath);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return {};
  return toSafeMetadata({ format: name.slice(dot + 1).toLowerCase() });
}

function toSafeMetadata(raw: Record<string, SafeMetadataValue>): Record<string, SafeMetadataValue> {
  const redacted: Record<string, SafeMetadataValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    redacted[key] = redactValue(value);
  }
  return filterToAllowlist(redacted, OPENCODE_SAFE_METADATA_ALLOWLIST);
}

function redactValue(value: SafeMetadataValue): SafeMetadataValue {
  if (typeof value === 'string') return capMetadataString(redactOpencode(value));
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

/**
 * Compile-time guard (roadmap M9 #131). If any builder helper's `kind` widens
 * back to `string`, this becomes `never`, and the assertion in the test fails.
 */
type KindParams =
  | Parameters<typeof symlinkElement>[2]
  | Parameters<typeof unreadableElement>[2]
  | Parameters<typeof skippedElement>[2]
  | Parameters<typeof skippedNonRegularElement>[2];
export type AssertKindsNarrow = string extends KindParams ? never : true;
