import type { SafeMetadataValue } from '../core/observed.js';

/**
 * Safe metadata allowlist (design doc §19). Each adapter explicitly defines
 * the metadata fields that may be persisted; unknown fields are not persisted
 * automatically. This helper enforces that: it copies only allowlisted keys
 * and never inspects values for secrets (that is the adapter's obligation,
 * before calling here).
 */
export function filterToAllowlist(
  metadata: Readonly<Record<string, SafeMetadataValue>>,
  allowlist: readonly string[],
): Record<string, SafeMetadataValue> {
  const allowed = new Set(allowlist);
  const filtered: Record<string, SafeMetadataValue> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (allowed.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}
