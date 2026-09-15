import { randomBytes } from 'node:crypto';
import { canonicalJsonStringify } from '../util/json.js';
import { sha256Digest } from '../util/hash.js';

/**
 * Stable identifiers used across the three data-model layers
 * (Observed Facts / Resolved Facts / Derived Interpretation, design doc §7).
 *
 * Each id type is branded so the compiler rejects passing one kind of id where
 * another is expected (for example an `ElementId` where an `ObservedSnapshotId`
 * is required). Build them through the constructors/generators below rather
 * than casting strings at call sites.
 *
 * Decisions (serialization, schema versioning, id derivation) are recorded in
 * `docs/design/adr/0001-snapshot-serialization-and-ids.md`.
 */

declare const idBrand: unique symbol;

type Brand<T, B extends string> = T & { readonly [idBrand]: B };

/** Identifies a harness element within an observation/resolution. Stable across runs. */
export type ElementId = Brand<string, 'ElementId'>;

/** Identifies an immutable ObservedSnapshot. */
export type ObservedSnapshotId = Brand<string, 'ObservedSnapshotId'>;

/** Identifies an immutable ResolvedSnapshot. */
export type ResolvedSnapshotId = Brand<string, 'ResolvedSnapshotId'>;

/** Identifies a Derived Interpretation. */
export type InterpretationId = Brand<string, 'InterpretationId'>;

/**
 * Stable runtime identifier. Should match `yuurei` where possible (design doc
 * §9); the initial set is `claude-code` and `codex`.
 */
export type RuntimeId = Brand<string, 'RuntimeId'>;

const RUNTIME_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Constructs a `RuntimeId`, rejecting shapes that cannot be filesystem/scope keys. */
export function runtimeId(value: string): RuntimeId {
  if (!RUNTIME_ID_PATTERN.test(value)) {
    throw new TypeError(`invalid runtime id: ${JSON.stringify(value)}`);
  }
  return value as RuntimeId;
}

function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

/**
 * A fresh ObservedSnapshot id. Snapshot ids identify an observation event, not
 * harness state, so they are unique per capture rather than content-derived
 * (design doc §15).
 */
export function generateObservedSnapshotId(): ObservedSnapshotId {
  return randomId('obs') as ObservedSnapshotId;
}

/** A fresh ResolvedSnapshot id. */
export function generateResolvedSnapshotId(): ResolvedSnapshotId {
  return randomId('res') as ResolvedSnapshotId;
}

/** A fresh Interpretation id. */
export function generateInterpretationId(): InterpretationId {
  return randomId('int') as InterpretationId;
}

/**
 * The stable identity of a harness element. Deliberately separate from
 * `ElementId` so the derivation rule is visible where elements are built.
 */
export interface ElementIdentity {
  runtimeId: RuntimeId;
  origin: string;
  path: string;
}

/**
 * Derives an `ElementId` from runtime + origin + path, so the same element
 * keeps the same id across runs and snapshot diffing does not report spurious
 * churn (issue #3). Never random.
 */
export function elementIdFor(identity: ElementIdentity): ElementId {
  const digest = sha256Digest(canonicalJsonStringify(identity));
  return `el_${digest.slice('sha256:'.length, 'sha256:'.length + 16)}` as ElementId;
}
