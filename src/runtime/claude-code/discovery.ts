import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { assembleObservedSnapshot } from '../../discovery/assemble.js';
import { frontmatterMetadata, readFrontmatter } from '../../discovery/frontmatter.js';
import { filterToAllowlist } from '../../discovery/metadata.js';
import { buildObservedElement } from '../../discovery/observed-element.js';
import { walkHarnessPaths } from '../../discovery/walk.js';
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
import { MAX_FILE_BYTES, MAX_PARSE_BYTES, limitExceededDiagnostic } from '../../limits.js';
import { inspectFileTarget, readTextFileGuarded } from '../../util/fs.js';
import { sha256Digest } from '../../util/hash.js';
import { packageVersion } from '../../version.js';
import type { AccessPolicy, ProjectContext } from '../types.js';
import { detectClaudeCode } from './detect.js';
import { CLAUDE_CODE_SAFE_METADATA_ALLOWLIST } from './metadata.js';
import {
  PROJECT_CONFIG_DIR,
  PROJECT_INSTRUCTION_FILES,
  PROJECT_MCP_FILE,
  SETTINGS_FILES,
  USER_ELEMENT_DIRS,
  USER_INSTRUCTION_FILE,
  USER_PLUGINS_DIR,
  USER_PROJECTS_DIR,
  encodeProjectDir,
  userConfigDir,
  type ClaudeCodeElementKind,
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

export async function discoverClaudeCode(
  project: ProjectContext,
  access: AccessPolicy,
  home: string = homedir(),
): Promise<ObservedSnapshot> {
  return collectClaudeCodeHarness(project, access, home);
}

/** The discovery core with an injected home, so tests need no global state. */
export async function collectClaudeCodeHarness(
  project: ProjectContext,
  access: AccessPolicy,
  home: string,
): Promise<ObservedSnapshot> {
  const elements: ObservedElement[] = [];
  const diagnostics: Diagnostic[] = [];

  const detection = access.allowOutsideProject
    ? await detectClaudeCode(home)
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
    await collectUser(project, home, elements, diagnostics);
  }
  elements.push(builtinLayer());

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
  for (const file of PROJECT_INSTRUCTION_FILES) {
    await addKnownFile(
      join(root, file),
      file,
      'project',
      'project',
      'instructions',
      root,
      elements,
      diagnostics,
    );
  }
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
  await addKnownFile(
    join(root, PROJECT_MCP_FILE),
    PROJECT_MCP_FILE,
    'project',
    'project',
    'mcp-configuration',
    root,
    elements,
    diagnostics,
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
  await collectUserMcp(join(home, '.claude.json'), home, elements, diagnostics);
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
): Promise<void> {
  const walked = await walkHarnessPaths(root, [subpath], {
    describeFile: (relativePath, content) => {
      const kind = resolveKind(relativePath);
      if (kind === null || kind === 'unknown') return {};
      const displayPath = displayPrefix ? `${displayPrefix}/${relativePath}` : relativePath;
      const read = readFrontmatter(content);
      if (read.malformed) diagnostics.push(malformedFrontmatterDiagnostic(displayPath));
      return toSafeMetadata(frontmatterMetadata(read.facts));
    },
  });
  diagnostics.push(...walked.diagnostics);

  for (const entry of walked.entries) {
    if (entry.kind === 'directory') continue;
    const kind = resolveKind(entry.relativePath);
    if (kind === null) continue;

    const displayPath = displayPrefix
      ? `${displayPrefix}/${entry.relativePath}`
      : entry.relativePath;
    if (entry.kind === 'symlink') {
      elements.push(symlinkElement(origin, scope, kind, displayPath));
      continue;
    }
    if (entry.skipReason !== undefined) {
      elements.push(
        skippedElement(origin, scope, kind, displayPath, reasonForWalkSkip(entry.skipReason)),
      );
      continue;
    }
    if (entry.kind === 'unknown') {
      elements.push(skippedNonRegularElement(origin, scope, kind, displayPath));
      continue;
    }
    if (kind === 'unknown') {
      elements.push(unsupportedElement(origin, scope, displayPath));
      continue;
    }
    if (entry.digest === undefined) {
      diagnostics.push(unreadableDiagnostic(displayPath));
      elements.push(unreadableElement(origin, scope, kind, displayPath));
      continue;
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
}

async function addKnownFile(
  absPath: string,
  displayPath: string,
  origin: NativeOrigin,
  scope: string,
  kind: ClaudeCodeElementKind,
  baseDir: string,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const target = await inspectFileTarget(absPath, baseDir);
  if (target.status === 'missing') return; // absence is not a finding
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
      configElement(origin, scope, 'permissions', `${displayPath}#permissions`, {
        allowCount: arrayLength(permissions['allow']),
        denyCount: arrayLength(permissions['deny']),
        askCount: arrayLength(permissions['ask']),
        ...(typeof permissions['defaultMode'] === 'string'
          ? { permissionMode: permissions['defaultMode'] }
          : {}),
      }),
    );
  }
  if (typeof parsed['defaultMode'] === 'string') {
    elements.push(
      configElement(origin, scope, 'approval-policy', `${displayPath}#defaultMode`, {
        approvalPolicy: parsed['defaultMode'],
      }),
    );
  }
  const hooks = parsed['hooks'];
  if (isRecord(hooks)) {
    elements.push(
      configElement(origin, scope, 'hooks', `${displayPath}#hooks`, {
        eventNames: Object.keys(hooks),
      }),
    );
  }
  if (typeof parsed['outputStyle'] === 'string') {
    elements.push(
      configElement(origin, scope, 'output-style', `${displayPath}#outputStyle`, {
        outputStyle: parsed['outputStyle'],
      }),
    );
  }
  const mcpServers = parsed['mcpServers'];
  if (isRecord(mcpServers)) {
    elements.push(
      configElement(origin, scope, 'mcp-configuration', `${displayPath}#mcpServers`, {
        serverNames: Object.keys(mcpServers),
      }),
    );
  }
  const enabledPlugins = parsed['enabledPlugins'];
  if (isRecord(enabledPlugins)) {
    elements.push(
      configElement(origin, scope, 'plugin', `${displayPath}#enabledPlugins`, {
        enabledPluginCount: Object.keys(enabledPlugins).length,
      }),
    );
  }
}

async function collectUserMcp(
  absPath: string,
  baseDir: string,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const read = await readTextFileGuarded(absPath, MAX_PARSE_BYTES, baseDir);
  if (read.status === 'missing') return;
  if (read.status === 'symlink') {
    elements.push(symlinkElement('user', 'user', 'mcp-configuration', '~/.claude.json'));
    return;
  }
  if (read.status === 'hardlink') {
    diagnostics.push(hardlinkDiagnostic('~/.claude.json'));
    elements.push(
      skippedElement(
        'user',
        'user',
        'mcp-configuration',
        '~/.claude.json',
        'hardlink-not-followed',
      ),
    );
    return;
  }
  if (read.status === 'not-regular') {
    diagnostics.push(nonRegularDiagnostic('~/.claude.json'));
    elements.push(skippedNonRegularElement('user', 'user', 'mcp-configuration', '~/.claude.json'));
    return;
  }
  if (read.status === 'too-large') {
    diagnostics.push(limitExceededDiagnostic('MAX_PARSE_BYTES', read.maxBytes, '~/.claude.json'));
    elements.push(
      skippedElement('user', 'user', 'mcp-configuration', '~/.claude.json', 'limit-exceeded'),
    );
    return;
  }
  if (read.status === 'unreadable') {
    diagnostics.push(unreadableDiagnostic('~/.claude.json'));
    elements.push(unreadableElement('user', 'user', 'mcp-configuration', '~/.claude.json'));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return;
  }
  if (!isRecord(parsed)) return;
  const mcpServers = parsed['mcpServers'];
  if (isRecord(mcpServers) && Object.keys(mcpServers).length > 0) {
    elements.push(
      configElement('user', 'user', 'mcp-configuration', '~/.claude.json#mcpServers', {
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

function unsupportedElement(origin: NativeOrigin, scope: string, path: string): ObservedElement {
  return buildObservedElement({
    runtimeId: RUNTIME_ID,
    origin,
    scope,
    kind: 'unknown',
    path,
    status: 'unsupported',
    reason: 'unsupported-by-adapter',
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

/** Built-in instruction layers exist but are never readable (design doc §12). */
function builtinLayer(): ObservedElement {
  return buildObservedElement({
    runtimeId: RUNTIME_ID,
    origin: 'builtin',
    scope: null,
    kind: 'runtime-provided-instructions',
    path: '(builtin) claude-code instruction layers',
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
