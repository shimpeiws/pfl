import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { assembleObservedSnapshot } from '../../discovery/assemble.js';
import { filterToAllowlist } from '../../discovery/metadata.js';
import { buildObservedElement } from '../../discovery/observed-element.js';
import { walkHarnessPaths } from '../../discovery/walk.js';
import type { Diagnostic } from '../../core/diagnostics.js';
import { runtimeId } from '../../core/ids.js';
import type {
  NativeOrigin,
  ObservedElement,
  ObservedProject,
  ObservedSnapshot,
  SafeMetadataValue,
} from '../../core/observed.js';
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
): Promise<ObservedSnapshot> {
  return collectClaudeCodeHarness(project, access, homedir());
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
    elements,
    diagnostics,
  );
  for (const file of SETTINGS_FILES) {
    await collectSettings(
      join(configDir, file),
      `${USER_PREFIX}/${file}`,
      'user',
      'user',
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
  await collectUserMcp(join(home, '.claude.json'), elements, diagnostics);
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
  const walked = await walkHarnessPaths(root, [subpath]);
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
    if (entry.kind === 'unknown' || kind === 'unknown') {
      elements.push(unsupportedElement(origin, scope, displayPath));
      continue;
    }
    if (entry.digest === undefined) {
      diagnostics.push({
        severity: 'warning',
        code: 'unreadable-file',
        message: `could not read ${displayPath}`,
        path: displayPath,
      });
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
        metadata: metadataForPath(displayPath),
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
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const entry = await lstat(absPath).catch(() => null);
  if (entry === null) return; // absence is not a finding
  if (entry.isSymbolicLink()) {
    elements.push(symlinkElement(origin, scope, kind, displayPath));
    return;
  }
  if (!entry.isFile()) return;

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
    diagnostics.push({
      severity: 'warning',
      code: 'unreadable-file',
      message: `could not read ${displayPath}`,
      path: displayPath,
    });
    elements.push(unreadableElement(origin, scope, kind, displayPath));
  }
}

async function collectSettings(
  absPath: string,
  displayPath: string,
  origin: NativeOrigin,
  scope: string,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const text = await readTextOrNull(absPath, displayPath, diagnostics);
  if (text === null) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
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
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const text = await readTextOrNull(absPath, '~/.claude.json', diagnostics);
  if (text === null) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
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

/**
 * Reads a file that may legitimately be absent: ENOENT means "not there", any
 * other failure is recorded so an unreadable setting is never mistaken for a
 * missing one.
 */
async function readTextOrNull(
  absPath: string,
  displayPath: string,
  diagnostics: Diagnostic[],
): Promise<string | null> {
  try {
    return await readFile(absPath, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null;
    diagnostics.push({
      severity: 'warning',
      code: 'unreadable-file',
      message: `could not read ${displayPath}`,
      path: displayPath,
    });
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
