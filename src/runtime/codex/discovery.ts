import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { assembleObservedSnapshot } from '../../discovery/assemble.js';
import { frontmatterMetadata, readFrontmatter } from '../../discovery/frontmatter.js';
import { filterToAllowlist } from '../../discovery/metadata.js';
import { buildObservedElement } from '../../discovery/observed-element.js';
import { walkHarnessPaths, type DiscoveredPath } from '../../discovery/walk.js';
import type { Diagnostic } from '../../core/diagnostics.js';
import { runtimeId } from '../../core/ids.js';
import type {
  NativeOrigin,
  ObservedElement,
  ObservedProject,
  ObservedReason,
  ObservedSnapshot,
  SafeMetadataValue,
} from '../../core/observed.js';
import {
  MAX_FILE_BYTES,
  MAX_PARSE_BYTES,
  MAX_ANCESTOR_DIRS,
  limitExceededDiagnostic,
} from '../../limits.js';
import { inspectFileTarget, readTextFileGuarded } from '../../util/fs.js';
import { sha256Digest } from '../../util/hash.js';
import { packageVersion } from '../../version.js';
import type { AccessPolicy, ProjectContext } from '../types.js';
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

export async function discoverCodex(
  project: ProjectContext,
  access: AccessPolicy,
  home: string = homedir(),
): Promise<ObservedSnapshot> {
  return collectCodexHarness(project, access, home);
}

/** The discovery core with an injected home, so tests need no global state. */
export async function collectCodexHarness(
  project: ProjectContext,
  access: AccessPolicy,
  home: string,
): Promise<ObservedSnapshot> {
  const elements: ObservedElement[] = [];
  const diagnostics: Diagnostic[] = [];

  const detection = access.allowOutsideProject
    ? await detectCodex(home)
    : {
        version: null,
        runtimeCompatibility: 'unverified' as const,
        diagnostics: [
          {
            severity: 'info' as const,
            code: 'consent-not-granted',
            message: 'user-scope discovery skipped: consent was not granted',
          },
        ],
      };
  diagnostics.push(...detection.diagnostics);

  await collectProject(project, elements, diagnostics);
  if (access.allowOutsideProject) {
    await collectAncestorInstructions(project, elements, diagnostics);
    await collectUser(project, home, elements, diagnostics);
  }
  elements.push(builtinLayer());

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
  // so a root file is never recorded twice. `.git` and `node_modules` are pruned,
  // and files under the project config directory are excluded by path: a file
  // there is already discovered as a skill, and recording it here too would mint
  // a second element under the same id.
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
    elements.push(configElement('approval-sandbox', `${displayPath}#approval`, approval));
  }

  const context: Record<string, SafeMetadataValue> = {};
  const model = scalarString(root, 'model');
  if (model !== undefined) context['model'] = model;
  const reasoningEffort = scalarString(root, 'model_reasoning_effort');
  if (reasoningEffort !== undefined) context['reasoningEffort'] = reasoningEffort;
  const serviceTier = scalarString(root, 'service_tier');
  if (serviceTier !== undefined) context['serviceTier'] = serviceTier;
  if (Object.keys(context).length > 0) {
    elements.push(configElement('compaction-controls', `${displayPath}#context`, context));
  }

  const mcpServers = root.tables.get('mcp_servers');
  if (mcpServers !== undefined && mcpServers.tables.size > 0) {
    elements.push(
      configElement('mcp-configuration', `${displayPath}#mcp_servers`, {
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
      configElement('plugin', `${displayPath}#plugins`, {
        pluginNames: [...plugins.tables.keys()],
        enabledPluginCount: enabled,
      }),
    );
  }

  const marketplaces = root.tables.get('marketplaces');
  if (marketplaces !== undefined && marketplaces.tables.size > 0) {
    elements.push(
      configElement('plugin', `${displayPath}#marketplaces`, {
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
        configElement('approval-sandbox', `${displayPath}#sandbox_workspace_write`, metadata),
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
        configElement('shell-environment', `${displayPath}#shell_environment_policy`, metadata),
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
          `${displayPath}#projects.${project.root}`,
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
          configElement('approval-sandbox', `${displayPath}#profiles.${name}`, metadata),
        );
      }
    }
  }

  // Every section the adapter does not model is recorded rather than dropped, so
  // a new runtime section surfaces instead of disappearing (roadmap §5 M7).
  for (const section of root.tables.keys()) {
    if ((MODELLED_CONFIG_SECTIONS as readonly string[]).includes(section)) continue;
    elements.push(unsupportedConfigSection(`${displayPath}#${section}`));
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
      configElement('hooks', `${displayPath}#hooks`, { eventNames: Object.keys(hooks) }),
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
  /** Regular-file filter: only matching files are read and recorded. */
  selectFile?: (relativePath: string) => boolean;
  /** Directory names the walk must not descend into. */
  pruneDirectories?: readonly string[];
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
    ...(options.selectFile !== undefined ? { selectFile: options.selectFile } : {}),
    ...(options.extractFrontmatter === false
      ? {}
      : {
          describeFile: (relativePath: string, content: string) => {
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
    if (kind === undefined) continue;
    const displayPath = displayPrefix
      ? `${displayPrefix}/${entry.relativePath}`
      : entry.relativePath;
    pushWalkedEntry(entry, origin, scope, kind, displayPath, elements, diagnostics);
  }
}

/**
 * Records one walked entry as an observed element. A symlink, a refused
 * hardlink or oversized file, a non-regular entry, and a file that could not be
 * read are each surfaced with their reason rather than dropped, which is the
 * best-effort invariant (design doc §10.2, §10.3, §18).
 */
function pushWalkedEntry(
  entry: DiscoveredPath,
  origin: NativeOrigin,
  scope: string,
  kind: CodexElementKind,
  displayPath: string,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): void {
  if (entry.kind === 'symlink') {
    elements.push(symlinkElement(origin, scope, kind, displayPath));
    return;
  }
  if (entry.skipReason !== undefined) {
    elements.push(
      skippedElement(origin, scope, kind, displayPath, reasonForWalkSkip(entry.skipReason)),
    );
    return;
  }
  if (entry.kind === 'unknown') {
    elements.push(skippedNonRegularElement(origin, scope, kind, displayPath));
    return;
  }
  if (entry.digest === undefined) {
    diagnostics.push(unreadableDiagnostic(displayPath));
    elements.push(unreadableElement(origin, scope, kind, displayPath));
    return;
  }
  elements.push(
    buildObservedElement({
      runtimeId: RUNTIME_ID,
      origin,
      scope,
      kind,
      path: displayPath,
      digest: entry.digest,
      ...(entry.sizeBytes !== undefined ? { sizeBytes: entry.sizeBytes } : {}),
      metadata: { ...metadataForPath(displayPath), ...(entry.metadata ?? {}) },
    }),
  );
}

async function addKnownFile(
  absPath: string,
  displayPath: string,
  origin: NativeOrigin,
  scope: string,
  kind: CodexElementKind,
  baseDir: string,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const target = await inspectFileTarget(absPath, baseDir);
  if (target.status === 'missing') return;
  if (target.status === 'symlink') {
    elements.push(symlinkElement(origin, scope, kind, displayPath));
    return;
  }
  if (target.status === 'hardlink') {
    diagnostics.push(hardlinkDiagnostic(displayPath));
    elements.push(skippedElement(origin, scope, kind, displayPath, 'hardlink-not-followed'));
    return;
  }
  if (target.status === 'not-regular') {
    diagnostics.push(nonRegularDiagnostic(displayPath));
    elements.push(skippedNonRegularElement(origin, scope, kind, displayPath));
    return;
  }
  if (target.status === 'unreadable') {
    diagnostics.push(unreadableDiagnostic(displayPath));
    elements.push(unreadableElement(origin, scope, kind, displayPath));
    return;
  }
  if ((target.sizeBytes ?? 0) > MAX_FILE_BYTES) {
    diagnostics.push(limitExceededDiagnostic('MAX_FILE_BYTES', MAX_FILE_BYTES, displayPath));
    elements.push(skippedElement(origin, scope, kind, displayPath, 'limit-exceeded'));
    return;
  }

  try {
    const content = await readFile(absPath);
    elements.push(
      buildObservedElement({
        runtimeId: RUNTIME_ID,
        origin,
        scope,
        kind,
        path: displayPath,
        digest: sha256Digest(content),
        sizeBytes: content.length,
        metadata: metadataForPath(displayPath),
      }),
    );
  } catch {
    diagnostics.push(unreadableDiagnostic(displayPath));
    elements.push(unreadableElement(origin, scope, kind, displayPath));
  }
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
    kind: 'unknown',
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

function scalarArrayLength(table: TomlTable, key: string): number | undefined {
  const value = table.scalars.get(key);
  return Array.isArray(value) ? value.length : undefined;
}

function symlinkElement(
  origin: NativeOrigin,
  scope: string,
  kind: string,
  path: string,
): ObservedElement {
  return buildObservedElement({
    runtimeId: RUNTIME_ID,
    origin,
    scope,
    kind,
    path,
    symlink: true,
    status: 'skipped',
    reason: 'symlink-not-followed',
  });
}

function unreadableElement(
  origin: NativeOrigin,
  scope: string,
  kind: string,
  path: string,
): ObservedElement {
  return buildObservedElement({
    runtimeId: RUNTIME_ID,
    origin,
    scope,
    kind,
    path,
    status: 'unreadable',
    reason: 'unreadable',
  });
}

function builtinLayer(): ObservedElement {
  return buildObservedElement({
    runtimeId: RUNTIME_ID,
    origin: 'builtin',
    scope: null,
    kind: 'runtime-provided-instructions',
    path: '(builtin) codex instruction layers',
    inspectability: 'opaque',
  });
}

function toObservedProject(project: ProjectContext): ObservedProject {
  return {
    id: project.id,
    displayName: project.displayName,
    root: project.root,
    ...(project.remote !== undefined ? { remote: project.remote } : {}),
  };
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

function skippedElement(
  origin: NativeOrigin,
  scope: string,
  kind: string,
  path: string,
  reason: ObservedReason,
): ObservedElement {
  return buildObservedElement({
    runtimeId: RUNTIME_ID,
    origin,
    scope,
    kind,
    path,
    status: 'skipped',
    reason,
  });
}

function skippedNonRegularElement(
  origin: NativeOrigin,
  scope: string,
  kind: string,
  path: string,
): ObservedElement {
  return skippedElement(origin, scope, kind, path, 'non-regular-file-not-opened');
}

function reasonForWalkSkip(skipReason: 'hardlink-not-followed' | 'file-too-large'): ObservedReason {
  return skipReason === 'hardlink-not-followed' ? 'hardlink-not-followed' : 'limit-exceeded';
}

function unreadableDiagnostic(displayPath: string): Diagnostic {
  return {
    severity: 'warning',
    code: 'unreadable-file',
    message: `could not read ${displayPath}`,
    path: displayPath,
  };
}

function nonRegularDiagnostic(displayPath: string): Diagnostic {
  return {
    severity: 'warning',
    code: 'non-regular-file',
    message: `not a regular file, not opened: ${displayPath}`,
    path: displayPath,
  };
}

function hardlinkDiagnostic(displayPath: string): Diagnostic {
  return {
    severity: 'warning',
    code: 'hardlink-not-followed',
    message: `hardlink not followed: ${displayPath}`,
    path: displayPath,
  };
}

function invalidTomlDiagnostic(displayPath: string): Diagnostic {
  return {
    severity: 'warning',
    code: 'invalid-toml',
    message: `could not fully parse ${displayPath}`,
    path: displayPath,
  };
}

function malformedFrontmatterDiagnostic(displayPath: string): Diagnostic {
  return {
    severity: 'warning',
    code: 'invalid-frontmatter',
    message: `frontmatter is malformed or unterminated: ${displayPath}`,
    path: displayPath,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
