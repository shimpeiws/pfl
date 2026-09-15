import { notImplemented } from '../cli/exit-codes.js';
import type { Finding } from '../core/interpretation.js';
import type { ResolvedSnapshot } from '../core/resolved.js';

/**
 * Descriptive findings (design doc §22). Findings interpret structure but
 * never judge harness quality: no good/bad, better/worse, recommended, or
 * ROI language.
 */
export function deriveFindings(_resolved: ResolvedSnapshot): Finding[] {
  notImplemented('finding derivation');
}
