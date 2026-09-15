import type { Diagnostic, Completeness } from './diagnostics.js';
import type { ElementId, ObservedSnapshotId, RuntimeId } from './ids.js';

/**
 * Observed Facts: facts read directly from the filesystem or runtime
 * configuration (design doc §7.1). Raw observations do not change when
 * inventory logic improves.
 */

/** Native source/origin of an element (design doc §11). */
export type NativeOrigin = 'project' | 'user' | 'managed' | 'plugin' | 'builtin' | 'unknown';

/** How much of a runtime-provided layer is observable (design doc §12). */
export type Inspectability = 'observable' | 'known-runtime-provided' | 'opaque';

/** Whether the element could be read at all (design doc §10, §18). */
export type ObservedStatus = 'observed' | 'unreadable' | 'unsupported' | 'skipped' | 'unknown';

/**
 * Why an element is not `observed` (design doc §10.2, §10.3). A closed union,
 * not a free string, so the reason is always one the model understands:
 *
 * - `symlink-not-followed` — recorded but never followed (design doc §10.3)
 * - `unsupported-by-adapter` — unknown inside a known search area (design doc §10.2)
 * - `unreadable` — present but could not be read (for example, permissions)
 * - `unknown` — the adapter could not classify why
 */
export const OBSERVED_REASONS = [
  'symlink-not-followed',
  'unsupported-by-adapter',
  'unreadable',
  'unknown',
] as const;

export type ObservedReason = (typeof OBSERVED_REASONS)[number];

/** A value that is safe to persist, as permitted by an adapter's allowlist (design doc §19). */
export type SafeMetadataValue =
  | string
  | number
  | boolean
  | null
  | readonly SafeMetadataValue[]
  | { readonly [key: string]: SafeMetadataValue };

export interface ObservedElementSource {
  path?: string;
  digest?: string;
  sizeBytes?: number;
  symlink?: boolean;
}

export interface ObservedElement {
  id: ElementId;

  native: {
    kind: string;
    origin: NativeOrigin;
    scope: string | null;
  };

  source: ObservedElementSource;

  inspectability: Inspectability;

  metadata: Record<string, SafeMetadataValue>;

  status: ObservedStatus;

  /** Required for every status other than `observed` (design doc §10.2, §10.3). */
  reason?: ObservedReason;
}

export interface ObservedProject {
  id: string;
  displayName: string;
  root: string;
  remote?: string;
}

export interface ObservedRuntime {
  id: RuntimeId;
  version: string | null;
}

export interface AdapterIdentity {
  id: string;
  version: string;
  runtimeCompatibility: 'verified' | 'unverified';
}

/** Design doc §13.1. Immutable once captured. */
export interface ObservedSnapshot {
  schemaVersion: string;
  snapshotId: ObservedSnapshotId;
  capturedAt: string;

  project: ObservedProject;
  runtime: ObservedRuntime;
  adapter: AdapterIdentity;

  elements: ObservedElement[];
  diagnostics: Diagnostic[];

  completeness: Completeness;

  digests: {
    observed: string;
  };
}
