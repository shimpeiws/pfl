import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { assembleObservedSnapshot } from '../../discovery/assemble.js';
import { duplicateNameGroups } from '../../discovery/duplicate-names.js';
import { frontmatterMetadata, readFrontmatter } from '../../discovery/frontmatter.js';
import { filterToAllowlist } from '../../discovery/metadata.js';
import { buildObservedElement } from '../../discovery/observed-element.js';
import { walkHarnessPaths, type DiscoveredPath } from '../../discovery/walk.js';
import type { Diagnostic } from '../../core/diagnostics.js';
import { withFragment } from '../../core/element-path.js';
import { runtimeId } from '../../core/ids.js';
import type {
  NativeOrigin,
  ObservedElement,
  ObservedSnapshot,
  SafeMetadataValue,
} from '../../core/observed.js';
import { MAX_PARSE_BYTES, MAX_ANCESTOR_DIRS, limitExceededDiagnostic } from '../../limits.js';
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
import { detectCodex } from './detect.js';
import { CODEX_SAFE_METADATA_ALLOWLIST } from './metadata.js';
import { redactCodex } from './redact.js';
import {
  MODELLED_CONFIG_SECTIONS,
  PROJECT_CONFIG_DIR,
  PROJECT_INSTRUCTION_FILES,
  PROJECT_SKILLS_DIR,
  PROJECT_WALK_PRUNE_DIRECTORIES,
  USER_CONFIG_FILE,
  USER_DIR_KIND,
  USER_ELEMENT_DIRS,
  USER_HOOKS_FILE,
  USER_INSTRUCTION_FILE,
  userConfigDir,
  type CodexElementKind,
  UNKNOWN_ELEMENT_KIND,
  type CodexRecordedKind,
} from './paths.js';
import { readTomlFacts, type TomlTable } from './toml.js';

/**
 * Discovers the Codex harness and builds an immutable ObservedSnapshot (design
 * doc §10, §31.2). Static only: config.toml is read as text and never evaluated,
 * approval/sandbox settings are values not applied, symlinks are never followed,
 * and user-scope paths are opened only when `access` allows it.
 */

const RUNTIME_ID = runtimeId('codex');
const USER_PREFIX = '~/.codex';

// The shared element builders, parameterised by this adapter's kind union so a
// misspelled kind is a compile error (roadmap M9 #90, #131).
const builders = createElementBuilders<CodexRecordedKind>(RUNTIME_ID);
const { symlinkElement, unreadableElement, skippedElement, skippedNonRegularElement } = builders;

/** The kinds that form a named catalog, where a cross-scope collision is possible. */
const CATALOG_KINDS: ReadonlySet<string> = new Set(['skills']);

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
 * Emits one diagnostic per catalog name defined more than once. Codex resolves
 * duplicate skill names deterministically, so the diagnostic records the fact
 * without asserting a winner. Mixed plugin + non-plugin groups are split so
 * non-plugin collisions are still reported.
 */
function detectDuplicateNames(
  elements: readonly ObservedElement[],
  diagnostics: Diagnostic[],
): void {
  const groups = duplicateNameGroups(elements, catalogIdentity);
  for (const { kind, name, entries, pluginOnly, hasPlugin } of groups) {
    // Mixed plugin + non-plugin: only suppress for skills (where plugin
    // namespacing is verified). Codex currently only has skills as a catalog
    // kind, so this guard is always true here.
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

export async function discoverCodex(
  project: ProjectContext,
  access: AccessPolicy,
  home: string = homedir(),
  pathValue: string = process.env['PATH'] ?? '',
): Promise<ObservedSnapshot> {
  return collectCodexHarness(project, access, home, pathValue);
}

/**
 * The discovery core with an injected home and `PATH`, so tests need no global
 * state and no dependence on the machine.
 */
export async function collectCodexHarness(
  project: ProjectContext,
  access: AccessPolicy,
  home: string,
  pathValue: string = process.env['PATH'] ?? '',
): Promise<ObservedSnapshot> {
  const elements: ObservedElement[] = [];
  const diagnostics: Diagnostic[] = [];

  const detection = grants(access, 'install')
    ? await detectCodex(home, pathValue)
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
  } else {
    // A missing user grant is a recorded absence, not an empty harness
    // (roadmap M8 #81).
    diagnostics.push({
      severity: 'info',
      code: 'consent-not-granted:user',
      message: 'user-scope discovery skipped: the user scope was not granted',
    });
  }
  elements.push(builtinLayer(RUNTIME_ID, '(builtin) codex instruction layers'));

  detectDuplicateNames(elements, diagnostics);

  return assembleObservedSnapshot({
    project: toObservedProject(project),
    runtime: { id: RUNTIME_ID, version: detection.version },
    adapter: {
      id: 'codex',
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
  // One subtree walk finds the project-root files and every nested `AGENTS.md`,
  // so a root file is never recorded twice. `.git`, `node_modules`, and nested
  // checkout boundaries are pruned, and files under the project config directory
  // are excluded by path: a file there is already discovered as a skill, and
  // recording it here too would mint a second element under the same id.
  await addWalkedArea(
    project.root,
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

  // Project-scoped skills live beside the user-scoped ones, not in the project
  // root, so they are walked as their own area and get frontmatter metadata.
  await addWalkedArea(
    project.root,
    join(PROJECT_CONFIG_DIR, PROJECT_SKILLS_DIR),
    '',
    'project',
    'project',
    () => 'skills',
    elements,
    diagnostics,
  );
}

/**
 * Codex reads `AGENTS.md` from the project's parent directories, so the walk
 * starts at `dirname(project.root)` and climbs at most `MAX_ANCESTOR_DIRS`
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
        file === 'AGENTS.override.md' ? 'fallback-instructions' : 'instructions',
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

/** The instruction kind a project-subtree file carries, or `undefined` to ignore it. */
function instructionKindForPath(relativePath: string): CodexElementKind | undefined {
  const name = basename(relativePath);
  if (name === 'AGENTS.override.md') return 'fallback-instructions';
  if (name === 'AGENTS.md') return 'instructions';
  return undefined;
}

/**
 * Whether a project-subtree path is a project instruction candidate. The project
 * config directory is excluded by *path*, not by name: only `<project>/.codex`
 * is the config directory, and pruning every `.codex` directory would miss a
 * nested instruction file in a subdirectory that happens to share the name. Its
 * files are discovered by the skills walk, so an `AGENTS.md` inside it is a skill
 * file, not a second instruction element.
 */
function isProjectInstructionPath(relativePath: string): boolean {
  return (
    instructionKindForPath(relativePath) !== undefined &&
    !relativePath.startsWith(`${PROJECT_CONFIG_DIR}/`)
  );
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
  await collectToml(
    join(configDir, USER_CONFIG_FILE),
    `${USER_PREFIX}/${USER_CONFIG_FILE}`,
    project,
    configDir,
    elements,
    diagnostics,
  );
  await collectHooks(
    join(configDir, USER_HOOKS_FILE),
    `${USER_PREFIX}/${USER_HOOKS_FILE}`,
    configDir,
    elements,
    diagnostics,
  );
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
      USER_DIR_KIND[dir] === 'rules' ? { extractPermissions: true } : {},
    );
  }
}

/** Reads config.toml and records structural config elements (never evaluating it). */
async function collectToml(
  absPath: string,
  displayPath: string,
  project: ProjectContext,
  baseDir: string,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const read = await readTextFileGuarded(absPath, MAX_PARSE_BYTES, baseDir);
  if (read.status === 'missing') return;
  if (read.status === 'symlink') {
    elements.push(symlinkElement('user', 'user', 'config', displayPath));
    return;
  }
  if (read.status === 'hardlink') {
    diagnostics.push(hardlinkDiagnostic(displayPath));
    elements.push(skippedElement('user', 'user', 'config', displayPath, 'hardlink-not-followed'));
    return;
  }
  if (read.status === 'not-regular') {
    diagnostics.push(nonRegularDiagnostic(displayPath));
    elements.push(skippedNonRegularElement('user', 'user', 'config', displayPath));
    return;
  }
  if (read.status === 'too-large') {
    diagnostics.push(limitExceededDiagnostic('MAX_PARSE_BYTES', read.maxBytes, displayPath));
    elements.push(skippedElement('user', 'user', 'config', displayPath, 'limit-exceeded'));
    return;
  }
  if (read.status === 'unreadable') {
    diagnostics.push(unreadableDiagnostic(displayPath));
    elements.push(unreadableElement('user', 'user', 'config', displayPath));
    return;
  }
  const facts = readTomlFacts(read.text);
  if (facts.malformed) diagnostics.push(invalidTomlDiagnostic(displayPath));
  const root = facts.root;

  const approval: Record<string, SafeMetadataValue> = {};
  const approvalPolicy = scalarString(root, 'approval_policy');
  if (approvalPolicy !== undefined) approval['approvalMode'] = approvalPolicy;
  const sandboxMode = scalarString(root, 'sandbox_mode');
  if (sandboxMode !== undefined) approval['sandboxMode'] = sandboxMode;
  if (Object.keys(approval).length > 0) {
    elements.push(
      configElement('approval-sandbox', withFragment(displayPath, 'approval'), approval),
    );
  }

  const modelConfig: Record<string, SafeMetadataValue> = {};
  const model = scalarString(root, 'model');
  if (model !== undefined) modelConfig['model'] = model;
  const reasoningEffort = scalarString(root, 'model_reasoning_effort');
  if (reasoningEffort !== undefined) modelConfig['reasoningEffort'] = reasoningEffort;
  const serviceTier = scalarString(root, 'service_tier');
  if (serviceTier !== undefined) modelConfig['serviceTier'] = serviceTier;
  if (Object.keys(modelConfig).length > 0) {
    elements.push(
      configElement('model-configuration', withFragment(displayPath, 'model'), modelConfig),
    );
  }

  // The context controls are the actual compaction inputs, distinct from the
  // model selection above. Only integer values are recorded.
  const context: Record<string, SafeMetadataValue> = {};
  const contextWindow = scalarInteger(root, 'model_context_window');
  if (contextWindow !== undefined) context['contextWindow'] = contextWindow;
  const maxOutputTokens = scalarInteger(root, 'model_max_output_tokens');
  if (maxOutputTokens !== undefined) context['maxOutputTokens'] = maxOutputTokens;
  const autoCompactTokenLimit = scalarInteger(root, 'model_auto_compact_token_limit');
  if (autoCompactTokenLimit !== undefined) context['autoCompactTokenLimit'] = autoCompactTokenLimit;
  if (Object.keys(context).length > 0) {
    elements.push(
      configElement('compaction-controls', withFragment(displayPath, 'context'), context),
    );
  }

  const mcpServers = root.tables.get('mcp_servers');
  if (mcpServers !== undefined && mcpServers.tables.size > 0) {
    elements.push(
      configElement('mcp-configuration', withFragment(displayPath, 'mcp_servers'), {
        serverNames: [...mcpServers.tables.keys()],
      }),
    );
  }

  const plugins = root.tables.get('plugins');
  if (plugins !== undefined && plugins.tables.size > 0) {
    let enabled = 0;
    for (const plugin of plugins.tables.values()) {
      if (plugin.scalars.get('enabled') === true) enabled += 1;
    }
    elements.push(
      configElement('plugin', withFragment(displayPath, 'plugins'), {
        pluginNames: [...plugins.tables.keys()],
        enabledPluginCount: enabled,
      }),
    );
  }

  const marketplaces = root.tables.get('marketplaces');
  if (marketplaces !== undefined && marketplaces.tables.size > 0) {
    elements.push(
      configElement('plugin', withFragment(displayPath, 'marketplaces'), {
        marketplaceNames: [...marketplaces.tables.keys()],
      }),
    );
  }

  const sandboxSection = root.tables.get('sandbox_workspace_write');
  if (sandboxSection !== undefined) {
    const metadata: Record<string, SafeMetadataValue> = {};
    const networkAccess = scalarBoolean(sandboxSection, 'network_access');
    if (networkAccess !== undefined) metadata['networkAccess'] = networkAccess;
    const writableRoots = scalarArrayLength(sandboxSection, 'writable_roots');
    if (writableRoots !== undefined) metadata['writableRootCount'] = writableRoots;
    if (Object.keys(metadata).length > 0) {
      elements.push(
        configElement(
          'approval-sandbox',
          withFragment(displayPath, 'sandbox_workspace_write'),
          metadata,
        ),
      );
    }
  }

  const shell = root.tables.get('shell_environment_policy');
  if (shell !== undefined) {
    const metadata: Record<string, SafeMetadataValue> = {};
    const inheritMode = scalarString(shell, 'inherit');
    if (inheritMode !== undefined) metadata['inheritMode'] = inheritMode;
    const set = shell.tables.get('set');
    if (set !== undefined) metadata['setKeyCount'] = set.scalars.size;
    if (Object.keys(metadata).length > 0) {
      elements.push(
        configElement(
          'shell-environment',
          withFragment(displayPath, 'shell_environment_policy'),
          metadata,
        ),
      );
    }
  }

  const projects = root.tables.get('projects');
  const projectEntry = projects?.tables.get(project.root);
  if (projectEntry !== undefined) {
    const trustLevel = scalarString(projectEntry, 'trust_level');
    if (trustLevel !== undefined) {
      elements.push(
        configElement(
          'project-configuration',
          withFragment(displayPath, `projects.${project.root}`),
          { trustLevel },
          'user',
          'project',
        ),
      );
    }
  }

  const profiles = root.tables.get('profiles');
  if (profiles !== undefined) {
    for (const [name, profile] of profiles.tables) {
      const metadata: Record<string, SafeMetadataValue> = {};
      const profileApproval = scalarString(profile, 'approval_policy');
      if (profileApproval !== undefined) metadata['approvalMode'] = profileApproval;
      const profileSandbox = scalarString(profile, 'sandbox_mode');
      if (profileSandbox !== undefined) metadata['sandboxMode'] = profileSandbox;
      if (Object.keys(metadata).length > 0) {
        elements.push(
          configElement(
            'approval-sandbox',
            withFragment(displayPath, `profiles.${name}`),
            metadata,
          ),
        );
      }
    }
  }

  // Every section the adapter does not model is recorded rather than dropped, so
  // a new runtime section surfaces instead of disappearing (roadmap §5 M7).
  for (const section of root.tables.keys()) {
    if ((MODELLED_CONFIG_SECTIONS as readonly string[]).includes(section)) continue;
    elements.push(unsupportedConfigSection(withFragment(displayPath, section)));
  }
}

async function collectHooks(
  absPath: string,
  displayPath: string,
  baseDir: string,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const read = await readTextFileGuarded(absPath, MAX_PARSE_BYTES, baseDir);
  if (read.status === 'missing') return;
  if (read.status === 'symlink') {
    elements.push(symlinkElement('user', 'user', 'hooks', displayPath));
    return;
  }
  if (read.status === 'hardlink') {
    diagnostics.push(hardlinkDiagnostic(displayPath));
    elements.push(skippedElement('user', 'user', 'hooks', displayPath, 'hardlink-not-followed'));
    return;
  }
  if (read.status === 'not-regular') {
    diagnostics.push(nonRegularDiagnostic(displayPath));
    elements.push(skippedNonRegularElement('user', 'user', 'hooks', displayPath));
    return;
  }
  if (read.status === 'too-large') {
    diagnostics.push(limitExceededDiagnostic('MAX_PARSE_BYTES', read.maxBytes, displayPath));
    elements.push(skippedElement('user', 'user', 'hooks', displayPath, 'limit-exceeded'));
    return;
  }
  if (read.status === 'unreadable') {
    diagnostics.push(unreadableDiagnostic(displayPath));
    elements.push(unreadableElement('user', 'user', 'hooks', displayPath));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    diagnostics.push({
      severity: 'warning',
      code: 'invalid-hooks',
      message: `could not parse ${displayPath}`,
      path: displayPath,
    });
    return;
  }
  if (!isRecord(parsed)) return;
  const hooks = parsed['hooks'];
  if (isRecord(hooks)) {
    elements.push(
      configElement('hooks', withFragment(displayPath, 'hooks'), {
        eventNames: Object.keys(hooks),
      }),
    );
  }
}

interface WalkedAreaOptions {
  /**
   * Extract frontmatter metadata from each file's content. Element directories
   * (skills, rules, memories) want it; a project-wide instruction walk does not,
   * because it reads unrelated files and must not treat their content as
   * instructions.
   */
  extractFrontmatter?: boolean;
  /**
   * Derive permission counts from a rule file's content instead of frontmatter.
   * The counts ride on the entry's metadata; the adapter emits them as a second
   * `permissions` element and leaves only `format` on the `rules` element, so a
   * rule pattern or command never leaves the walk (design doc §19).
   */
  extractPermissions?: boolean;
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
  resolveKind: (relativePath: string) => CodexElementKind | undefined,
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
    ...(options.extractFrontmatter === false && options.extractPermissions !== true
      ? {}
      : {
          describeFile: (relativePath: string, content: string) => {
            const displayPath = displayPrefix ? `${displayPrefix}/${relativePath}` : relativePath;
            if (options.extractPermissions === true) {
              return toSafeMetadata(permissionCounts(content));
            }
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
    if (kind === undefined) continue;
    const displayPath = displayPrefix
      ? `${displayPrefix}/${entry.relativePath}`
      : entry.relativePath;
    // A `rules` element carries only its file format; the permission counts ride
    // on a separate `permissions` element at `<file>#permissions`.
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
      keepEntryMetadata: options.extractPermissions !== true,
    });
    if (options.extractPermissions === true) {
      pushPermissionsFragment(entry, origin, scope, displayPath, elements);
    }
  }
}

/**
 * A `.rules` file's permission counts as a second element. Only the counts
 * leave the walk — a pattern, command, or argument never does (design doc §19,
 * §31.2). The `#permissions` fragment is a different path from the `rules`
 * element, so it is a different element id and cannot collide with it.
 */
function pushPermissionsFragment(
  entry: DiscoveredPath,
  origin: NativeOrigin,
  scope: string,
  displayPath: string,
  elements: ObservedElement[],
): void {
  if (entry.kind !== 'file' || entry.skipReason !== undefined || entry.digest === undefined) return;
  const allowCount = entry.metadata?.['allowCount'];
  const denyCount = entry.metadata?.['denyCount'];
  if (typeof allowCount !== 'number' || typeof denyCount !== 'number') return;
  elements.push(
    buildObservedElement({
      runtimeId: RUNTIME_ID,
      origin,
      scope,
      kind: 'permissions',
      path: withFragment(displayPath, 'permissions'),
      digest: entry.digest,
      ...(entry.sizeBytes !== undefined ? { sizeBytes: entry.sizeBytes } : {}),
      metadata: toSafeMetadata({ allowCount, denyCount }),
    }),
  );
}

/**
 * Counts `prefix_rule(...)` decisions in a `.rules` file: `decision="allow"` is
 * an allow, `decision="forbidden"` or `"deny"` is a deny. Comments and blank
 * lines are ignored. Counts only — no pattern, command, or argument is ever
 * returned, so redaction is not the only thing between a rule body and the
 * store.
 */
function permissionCounts(content: string): Record<string, SafeMetadataValue> {
  let allowCount = 0;
  let denyCount = 0;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || !line.includes('prefix_rule(')) continue;
    const decision = ruleDecision(line);
    if (decision === 'allow') allowCount += 1;
    else if (decision === 'forbidden' || decision === 'deny') denyCount += 1;
  }
  return { allowCount, denyCount };
}

const RULE_DECISION = /\bdecision\s*=\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))/;

function ruleDecision(line: string): string | undefined {
  const match = RULE_DECISION.exec(line);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function addKnownFile(
  absPath: string,
  displayPath: string,
  origin: NativeOrigin,
  scope: string,
  kind: CodexElementKind,
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
  kind: CodexElementKind,
  path: string,
  raw: Record<string, SafeMetadataValue>,
  origin: NativeOrigin = 'user',
  scope = 'user',
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

/**
 * A `config.toml` section the adapter knows exists but does not model. Recorded
 * as `unsupported` so it is visible rather than silently ignored.
 */
function unsupportedConfigSection(path: string): ObservedElement {
  return buildObservedElement({
    runtimeId: RUNTIME_ID,
    origin: 'user',
    scope: 'user',
    kind: UNKNOWN_ELEMENT_KIND,
    path,
    status: 'unsupported',
    reason: 'unsupported-by-adapter',
  });
}

function scalarString(table: TomlTable, key: string): string | undefined {
  const value = table.scalars.get(key);
  return typeof value === 'string' ? value : undefined;
}

function scalarBoolean(table: TomlTable, key: string): boolean | undefined {
  const value = table.scalars.get(key);
  return typeof value === 'boolean' ? value : undefined;
}

function scalarInteger(table: TomlTable, key: string): number | undefined {
  const value = table.scalars.get(key);
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function scalarArrayLength(table: TomlTable, key: string): number | undefined {
  const value = table.scalars.get(key);
  return Array.isArray(value) ? value.length : undefined;
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
  return filterToAllowlist(redacted, CODEX_SAFE_METADATA_ALLOWLIST);
}

function redactValue(value: SafeMetadataValue): SafeMetadataValue {
  if (typeof value === 'string') return redactCodex(value);
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
 * The `@ts-expect-error` test pins the kind union; this pins the helpers that
 * use it, which the union alone does not.
 */
type KindParams =
  | Parameters<typeof symlinkElement>[2]
  | Parameters<typeof unreadableElement>[2]
  | Parameters<typeof skippedElement>[2]
  | Parameters<typeof skippedNonRegularElement>[2];
export type AssertKindsNarrow = string extends KindParams ? never : true;

function invalidTomlDiagnostic(displayPath: string): Diagnostic {
  return {
    severity: 'warning',
    code: 'invalid-toml',
    message: `could not fully parse ${displayPath}`,
    path: displayPath,
  };
}
