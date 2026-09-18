import { readFile } from 'node:fs/promises';
import type { Diagnostic } from '../core/diagnostics.js';
import type { RuntimeId } from '../core/ids.js';
import { MAX_FILE_BYTES, limitExceededDiagnostic } from '../limits.js';
import { inspectFileTarget } from '../util/fs.js';
import { sha256Digest } from '../util/hash.js';
import type {
  NativeOrigin,
  ObservedElement,
  ObservedProject,
  ObservedReason,
  SafeMetadataValue,
} from '../core/observed.js';
import { buildObservedElement } from '../discovery/observed-element.js';
import type { DiscoveredPath } from '../discovery/walk.js';
import type { ProjectContext, RuntimeDetection } from './types.js';

/**
 * The mechanical half of a runtime adapter (roadmap M9 #90). These helpers are
 * identical across the adapters; keeping them here means a third adapter
 * inherits them and a repair lands once. An adapter supplies only what is
 * genuinely runtime knowledge: its `RuntimeId`, its path tables, its kind
 * mapping, its format readers, and its allowlist and redactor.
 *
 * The element builders are created per runtime so the adapter keeps its own
 * `kind` union: `createElementBuilders<ClaudeCodeRecordedKind>(id)` yields
 * helpers whose `kind` parameter is that union, so a typo is a compile error
 * rather than a different `ElementId` (roadmap M9 #131).
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ElementBuilders<K extends string> {
  symlinkElement(origin: NativeOrigin, scope: string, kind: K, path: string): ObservedElement;
  /** An item inside a known area the adapter cannot classify. */
  unsupportedElement(origin: NativeOrigin, scope: string, path: string): ObservedElement;
  unreadableElement(origin: NativeOrigin, scope: string, kind: K, path: string): ObservedElement;
  skippedElement(
    origin: NativeOrigin,
    scope: string,
    kind: K,
    path: string,
    reason: ObservedReason,
  ): ObservedElement;
  skippedNonRegularElement(
    origin: NativeOrigin,
    scope: string,
    kind: K,
    path: string,
  ): ObservedElement;
}

export function createElementBuilders<K extends string>(runtimeId: RuntimeId): ElementBuilders<K> {
  return {
    symlinkElement(origin, scope, kind, path) {
      return buildObservedElement({
        runtimeId,
        origin,
        scope,
        kind,
        path,
        symlink: true,
        status: 'skipped',
        reason: 'symlink-not-followed',
      });
    },
    unsupportedElement(origin, scope, path) {
      return buildObservedElement({
        runtimeId,
        origin,
        scope,
        kind: 'unknown',
        path,
        status: 'unsupported',
        reason: 'unsupported-by-adapter',
      });
    },
    unreadableElement(origin, scope, kind, path) {
      return buildObservedElement({
        runtimeId,
        origin,
        scope,
        kind,
        path,
        status: 'unreadable',
        reason: 'unreadable',
      });
    },
    skippedElement(origin, scope, kind, path, reason) {
      return buildObservedElement({
        runtimeId,
        origin,
        scope,
        kind,
        path,
        status: 'skipped',
        reason,
      });
    },
    skippedNonRegularElement(origin, scope, kind, path) {
      return buildObservedElement({
        runtimeId,
        origin,
        scope,
        kind,
        path,
        status: 'skipped',
        reason: 'non-regular-file-not-opened',
      });
    },
  };
}

/** Built-in instruction layers exist but are never readable (design doc §12). */
export function builtinLayer(runtimeId: RuntimeId, path: string): ObservedElement {
  return buildObservedElement({
    runtimeId,
    origin: 'builtin',
    scope: null,
    kind: 'runtime-provided-instructions',
    path,
    inspectability: 'opaque',
  });
}

/**
 * Reads one known file and records it, or records why it could not be read
 * (roadmap M9 #90). The symlink, hardlink, non-regular, and size decisions are
 * the shared part; the adapter supplies its metadata function.
 */
export interface AddKnownFileParams<K extends string> {
  runtimeId: RuntimeId;
  /** The adapter's element builders, so `kind` is pinned to its own union. */
  builders: ElementBuilders<K>;
  absPath: string;
  displayPath: string;
  origin: NativeOrigin;
  scope: string;
  kind: K;
  baseDir: string;
  metadataForPath: (displayPath: string) => Record<string, SafeMetadataValue>;
  elements: ObservedElement[];
  diagnostics: Diagnostic[];
}

export async function addKnownFile<K extends string>(params: AddKnownFileParams<K>): Promise<void> {
  const { absPath, displayPath, origin, scope, baseDir, elements, diagnostics, builders } = params;
  const target = await inspectFileTarget(absPath, baseDir);
  if (target.status === 'missing') return; // absence is not a finding
  if (target.status === 'symlink') {
    elements.push(builders.symlinkElement(origin, scope, params.kind, displayPath));
    return;
  }
  if (target.status === 'hardlink') {
    diagnostics.push(hardlinkDiagnostic(displayPath));
    elements.push(
      builders.skippedElement(origin, scope, params.kind, displayPath, 'hardlink-not-followed'),
    );
    return;
  }
  if (target.status === 'not-regular') {
    diagnostics.push(nonRegularDiagnostic(displayPath));
    elements.push(builders.skippedNonRegularElement(origin, scope, params.kind, displayPath));
    return;
  }
  if (target.status === 'unreadable') {
    diagnostics.push(unreadableDiagnostic(displayPath));
    elements.push(builders.unreadableElement(origin, scope, params.kind, displayPath));
    return;
  }
  if ((target.sizeBytes ?? 0) > MAX_FILE_BYTES) {
    diagnostics.push(limitExceededDiagnostic('MAX_FILE_BYTES', MAX_FILE_BYTES, displayPath));
    elements.push(
      builders.skippedElement(origin, scope, params.kind, displayPath, 'limit-exceeded'),
    );
    return;
  }

  try {
    const content = await readFile(absPath);
    elements.push(
      buildObservedElement({
        runtimeId: params.runtimeId,
        origin,
        scope,
        kind: params.kind,
        path: displayPath,
        digest: sha256Digest(content),
        sizeBytes: content.length,
        metadata: params.metadataForPath(displayPath),
      }),
    );
  } catch {
    diagnostics.push(unreadableDiagnostic(displayPath));
    elements.push(builders.unreadableElement(origin, scope, params.kind, displayPath));
  }
}

/**
 * Turns one walked entry into an observed element, or a diagnostic plus a
 * skipped/unreadable element (roadmap M9 #90). This is the common shape of a
 * walked area: the adapter supplies the runtime id, the resolved kind, and its
 * metadata function; the symlink/hardlink/non-regular/limit decisions are here.
 *
 * Every unreadable, unsupported, or skipped entry is recorded with its reason
 * rather than dropped, which is the best-effort invariant (design doc §10.2,
 * §10.3, §18).
 *
 * `unsupported` records the item as `unsupported-by-adapter` (Claude Code's
 * unknown-kind path). It is checked after the non-regular case to preserve the
 * existing order, where an unknown-kind non-regular entry is still reported as
 * skipped.
 */
export interface PushWalkedEntryParams<K extends string> {
  runtimeId: RuntimeId;
  /** The adapter's element builders, so `kind` is pinned to its own union. */
  builders: ElementBuilders<K>;
  entry: DiscoveredPath;
  origin: NativeOrigin;
  scope: string;
  kind: K;
  displayPath: string;
  metadataForPath: (displayPath: string) => Record<string, SafeMetadataValue>;
  elements: ObservedElement[];
  diagnostics: Diagnostic[];
  keepEntryMetadata?: boolean;
  unsupported?: boolean;
}

export function pushWalkedEntry<K extends string>(params: PushWalkedEntryParams<K>): void {
  const { entry, origin, scope, kind, displayPath, elements, diagnostics, builders } = params;
  if (entry.kind === 'symlink') {
    elements.push(builders.symlinkElement(origin, scope, kind, displayPath));
    return;
  }
  if (entry.skipReason !== undefined) {
    elements.push(
      builders.skippedElement(
        origin,
        scope,
        kind,
        displayPath,
        reasonForWalkSkip(entry.skipReason),
      ),
    );
    return;
  }
  if (entry.kind === 'unknown') {
    elements.push(builders.skippedNonRegularElement(origin, scope, kind, displayPath));
    return;
  }
  if (params.unsupported === true) {
    elements.push(builders.unsupportedElement(origin, scope, displayPath));
    return;
  }
  if (entry.digest === undefined) {
    diagnostics.push(unreadableDiagnostic(displayPath));
    elements.push(builders.unreadableElement(origin, scope, kind, displayPath));
    return;
  }
  elements.push(
    buildObservedElement({
      runtimeId: params.runtimeId,
      origin,
      scope,
      kind,
      path: displayPath,
      digest: entry.digest,
      ...(entry.sizeBytes !== undefined ? { sizeBytes: entry.sizeBytes } : {}),
      metadata: {
        ...params.metadataForPath(displayPath),
        ...(params.keepEntryMetadata !== false ? (entry.metadata ?? {}) : {}),
      },
    }),
  );
}

export function toObservedProject(project: ProjectContext): ObservedProject {
  return {
    id: project.id,
    displayName: project.displayName,
    root: project.root,
    ...(project.remote !== undefined ? { remote: project.remote } : {}),
  };
}

function reasonForWalkSkip(skipReason: 'hardlink-not-followed' | 'file-too-large'): ObservedReason {
  return skipReason === 'hardlink-not-followed' ? 'hardlink-not-followed' : 'limit-exceeded';
}

export function unreadableDiagnostic(displayPath: string): Diagnostic {
  return {
    severity: 'warning',
    code: 'unreadable-file',
    message: `could not read ${displayPath}`,
    path: displayPath,
  };
}

export function nonRegularDiagnostic(displayPath: string): Diagnostic {
  return {
    severity: 'warning',
    code: 'non-regular-file',
    message: `not a regular file, not opened: ${displayPath}`,
    path: displayPath,
  };
}

export function hardlinkDiagnostic(displayPath: string): Diagnostic {
  return {
    severity: 'warning',
    code: 'hardlink-not-followed',
    message: `hardlink not followed: ${displayPath}`,
    path: displayPath,
  };
}

export function malformedFrontmatterDiagnostic(displayPath: string): Diagnostic {
  return {
    severity: 'warning',
    code: 'invalid-frontmatter',
    message: `frontmatter is malformed or unterminated: ${displayPath}`,
    path: displayPath,
  };
}

/** The resolution event target, shared by the adapters (design doc §11). */
export function eventTarget(element: ObservedElement): { target?: string } {
  const events = element.metadata['eventNames'];
  if (!Array.isArray(events)) return {};
  const names = events.filter((value): value is string => typeof value === 'string');
  return names.length > 0 ? { target: names.join(',') } : {};
}

/**
 * The `detect` verdict when the install scope is not granted: `unknown`, not
 * `no`, so "not consented" stays distinguishable from "not installed" (roadmap
 * M7 #76).
 */
export function installScopeNotGranted(runtimeId: RuntimeId): RuntimeDetection {
  return {
    runtimeId,
    installed: 'unknown',
    version: null,
    runtimeCompatibility: 'unverified',
    diagnostics: [
      {
        severity: 'info',
        code: 'consent-not-granted:install',
        message:
          'runtime detection reads installation metadata outside the project and needs consent',
      },
    ],
  };
}
