import type { Diagnostic, Completeness } from './diagnostics.js';
import type { ElementId, ObservedSnapshotId, RuntimeId } from './ids.js';

/**
 * Observed Facts: facts read directly from the filesystem or runtime
 * configuration (design doc §7.1). Raw observations do not change when
 * inventory logic improves.
 */

/**
 * Native source/origin of an element (design doc §11). The array is the single
 * source; the type derives from it, so a persisted-shape validator that imports
 * the array cannot drift from the model (roadmap M8 #88).
 */
export const NATIVE_ORIGIN_VALUES = [
  'project',
  'user',
  'managed',
  'plugin',
  'builtin',
  'unknown',
] as const;
export type NativeOrigin = (typeof NATIVE_ORIGIN_VALUES)[number];

/** How much of a runtime-provided layer is observable (design doc §12). */
export const INSPECTABILITY_VALUES = ['observable', 'known-runtime-provided', 'opaque'] as const;
export type Inspectability = (typeof INSPECTABILITY_VALUES)[number];

/** Whether the element could be read at all (design doc §10, §18). */
export const OBSERVED_STATUS_VALUES = [
  'observed',
  'unreadable',
  'unsupported',
  'skipped',
  'unknown',
] as const;
export type ObservedStatus = (typeof OBSERVED_STATUS_VALUES)[number];

/**
 * Why an element is not `observed` (design doc §10.2, §10.3). A closed union,
 * not a free string, so the reason is always one the model understands:
 *
 * - `symlink-not-followed` — recorded but never followed (design doc §10.3)
 * - `hardlink-not-followed` — an inode reachable outside the walk root (roadmap S3)
 * - `non-regular-file-not-opened` — a FIFO, socket, or device, never opened (§18)
 * - `limit-exceeded` — a resource ceiling was hit before the element was read (§18)
 * - `unsupported-by-adapter` — unknown inside a known search area (design doc §10.2)
 * - `unreadable` — present but could not be read (for example, permissions)
 * - `unknown` — the adapter could not classify why
 */
export const OBSERVED_REASONS = [
  'symlink-not-followed',
  'hardlink-not-followed',
  'non-regular-file-not-opened',
  'limit-exceeded',
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

  readonly elements: readonly ObservedElement[];
  readonly diagnostics: readonly Diagnostic[];

  completeness: Completeness;

  digests: {
    observed: string;
  };
}
