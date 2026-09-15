import { notImplemented } from '../../cli/exit-codes.js';
import type { ObservedSnapshot } from '../../core/observed.js';
import type { ResolvedSnapshot } from '../../core/resolved.js';

/**
 * Apply Codex's native precedence and accumulation rules to produce a
 * ResolvedSnapshot (design doc §8, §11).
 */
export async function resolveCodex(_observed: ObservedSnapshot): Promise<ResolvedSnapshot> {
  notImplemented('Codex resolution');
}
