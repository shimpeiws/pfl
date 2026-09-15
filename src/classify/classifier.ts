import { notImplemented } from '../cli/exit-codes.js';
import type { Interpretation } from '../core/interpretation.js';
import type { ResolvedSnapshot } from '../core/resolved.js';

/**
 * Deterministic, local, LLM-free semantic classification (design doc §21).
 * Assigns the initial six semantic facets to resolved elements with a
 * confidence, and computes stats. Native facts remain authoritative even when
 * classification is imperfect.
 */
export async function classify(
  _resolved: ResolvedSnapshot,
): Promise<Omit<Interpretation, 'interpretationId' | 'resolvedSnapshotId' | 'findings'>> {
  notImplemented('semantic classification');
}
