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
import { detectCodex } from './detect.js';
import { CODEX_SAFE_METADATA_ALLOWLIST } from './metadata.js';
import { redactCodex } from './redact.js';
import {
  PROJECT_INSTRUCTION_FILES,
  USER_CONFIG_FILE,
  USER_DIR_KIND,
  USER_ELEMENT_DIRS,
  USER_HOOKS_FILE,
  USER_INSTRUCTION_FILE,
  userConfigDir,
  type CodexElementKind,
} from './paths.js';
import { readTomlFacts } from './toml.js';

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
): Promise<ObservedSnapshot> {
  return collectCodexHarness(project, access, homedir());
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
    : { version: null, runtimeCompatibility: 'unverified' as const };

  await collectProject(project, elements, diagnostics);
  if (access.allowOutsideProject) {
    await collectUser(home, elements, diagnostics);
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
  });
}

async function collectProject(
  project: ProjectContext,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  for (const file of PROJECT_INSTRUCTION_FILES) {
    // AGENTS.override.md is recorded as the fallback layer; whether it replaces
    // or layers over AGENTS.md is resolution (M2, #15), never guessed here.
    const kind: CodexElementKind =
      file === 'AGENTS.override.md' ? 'fallback-instructions' : 'instructions';
    await addKnownFile(
      join(project.root, file),
      file,
      'project',
      'project',
      kind,
      elements,
      diagnostics,
    );
  }
}

async function collectUser(
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
  await collectToml(
    join(configDir, USER_CONFIG_FILE),
    `${USER_PREFIX}/${USER_CONFIG_FILE}`,
    elements,
  );
  await collectHooks(
    join(configDir, USER_HOOKS_FILE),
    `${USER_PREFIX}/${USER_HOOKS_FILE}`,
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
  elements: ObservedElement[],
): Promise<void> {
  const text = await readFile(absPath, 'utf8').catch(() => null);
  if (text === null) return;
  const facts = readTomlFacts(text);

  const approval: Record<string, SafeMetadataValue> = {
    ...(facts.values['approval_policy'] !== undefined
      ? { approvalMode: facts.values['approval_policy'] }
      : {}),
    ...(facts.values['sandbox_mode'] !== undefined
      ? { sandboxMode: facts.values['sandbox_mode'] }
      : {}),
  };
  if (Object.keys(approval).length > 0) {
    elements.push(configElement('approval-sandbox', `${displayPath}#approval`, approval));
  }

  const context: Record<string, SafeMetadataValue> = {
    ...(facts.values['model'] !== undefined ? { model: facts.values['model'] } : {}),
    ...(facts.values['model_reasoning_effort'] !== undefined
      ? { reasoningEffort: facts.values['model_reasoning_effort'] }
      : {}),
    ...(facts.values['service_tier'] !== undefined
      ? { serviceTier: facts.values['service_tier'] }
      : {}),
  };
  if (Object.keys(context).length > 0) {
    elements.push(configElement('compaction-controls', `${displayPath}#context`, context));
  }

  if (facts.mcpServers.length > 0) {
    elements.push(
      configElement('mcp-configuration', `${displayPath}#mcp_servers`, {
        serverNames: facts.mcpServers,
      }),
    );
  }
  // Plugins are intentionally not recorded: §31.2's kinds have no plugin layer.
  void facts.plugins;
}

async function collectHooks(
  absPath: string,
  displayPath: string,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const text = await readFile(absPath, 'utf8').catch(() => null);
  if (text === null) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
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

async function addWalkedArea(
  root: string,
  subpath: string,
  displayPrefix: string,
  origin: NativeOrigin,
  scope: string,
  resolveKind: (relativePath: string) => CodexElementKind,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const walked = await walkHarnessPaths(root, [subpath]);
  diagnostics.push(...walked.diagnostics);

  for (const entry of walked.entries) {
    if (entry.kind === 'directory') continue;
    const kind = resolveKind(entry.relativePath);
    const displayPath = displayPrefix
      ? `${displayPrefix}/${entry.relativePath}`
      : entry.relativePath;

    if (entry.kind === 'symlink') {
      elements.push(symlinkElement(origin, scope, kind, displayPath));
      continue;
    }
    if (entry.kind === 'unknown') {
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
  kind: CodexElementKind,
  elements: ObservedElement[],
  diagnostics: Diagnostic[],
): Promise<void> {
  const entry = await lstat(absPath).catch(() => null);
  if (entry === null) return;
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

function configElement(
  kind: CodexElementKind,
  path: string,
  raw: Record<string, SafeMetadataValue>,
): ObservedElement {
  return buildObservedElement({
    runtimeId: RUNTIME_ID,
    origin: 'user',
    scope: 'user',
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
