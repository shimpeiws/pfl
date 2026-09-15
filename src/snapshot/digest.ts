import type { ObservedElement } from '../core/observed.js';
import { sha256Digest } from '../util/hash.js';
import { canonicalJsonStringify } from '../util/json.js';

/**
 * Digests (design doc §15).
 *
 * - Harness Content Digest: statically observable harness content.
 * - Resolved Snapshot Digest: harness content + runtime identity + runtime
 *   version + resolution semantics version, so the same harness content under
 *   a different runtime version can produce a different resolved digest.
 *
 * Opaque builtin layers are not mixed into content digests as if their
 * contents were known (design doc §12).
 */

/** Elements are sorted by id so discovery order cannot change the digest. */
export function harnessContentDigest(elements: readonly ObservedElement[]): string {
  const observable = elements
    .filter((element) => element.inspectability !== 'opaque')
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sha256Digest(canonicalJsonStringify(observable));
}

export interface ResolvedDigestInput {
  harnessContentDigest: string;
  runtimeId: string;
  runtimeVersion: string | null;
  semanticsVersion: string;
}

export function resolvedSnapshotDigest(input: ResolvedDigestInput): string {
  return sha256Digest(canonicalJsonStringify(input));
}
