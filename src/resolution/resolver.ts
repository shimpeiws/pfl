import { notImplemented } from '../cli/exit-codes.js';
import type { ObservedSnapshot } from '../core/observed.js';
import type { ResolvedSnapshot } from '../core/resolved.js';
import type { RuntimeAdapter } from '../runtime/types.js';

/**
 * Runtime-agnostic resolution entry point (design doc §11). The normalized
 * model separates Native source, Applicability, Resolution semantics, and
 * Activation; a single global precedence rank is insufficient. Runtime-specific
 * precedence and accumulation rules live in each adapter's `resolve`.
 */
export async function resolveHarness(
  adapter: RuntimeAdapter,
  observed: ObservedSnapshot,
): Promise<ResolvedSnapshot> {
  return adapter.resolve(observed);
}

export function notYetImplemented(): never {
  notImplemented('harness resolution');
}
