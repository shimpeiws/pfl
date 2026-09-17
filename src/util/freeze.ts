/**
 * Recursively freezes a value so a caller that later mutates an object it
 * handed in cannot desynchronize a snapshot from the digest computed at
 * assembly time (design doc §15: snapshots are immutable).
 *
 * Only objects are frozen; primitives are returned unchanged. The check skips
 * already-frozen values so a shared subtree is not walked twice.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
