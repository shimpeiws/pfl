import { readFile } from 'node:fs/promises';
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
  ObservedReason,
  ObservedSnapshot,
  SafeMetadataValue,
} from '../../core/observed.js';
import { MAX_FILE_BYTES, MAX_PARSE_BYTES, limitExceededDiagnostic } from '../../limits.js';
import { inspectFileTarget, readTextFileGuarded } from '../../util/fs.js';
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
      project.root,
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
    configDir,
    elements,
    diagnostics,
  );
  await collectToml(
    join(configDir, USER_CONFIG_FILE),
    `${USER_PREFIX}/${USER_CONFIG_FILE}`,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
