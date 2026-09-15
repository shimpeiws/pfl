import { notImplemented } from '../cli/exit-codes.js';
import type { Diagnostic } from '../core/diagnostics.js';

/**
 * A discovered filesystem entry. Symlinks are recorded but never followed
 * (design doc §10.3); they surface as `kind: 'symlink'` and are reported as
 * skipped by the caller.
 */
export interface DiscoveredPath {
  /** Path relative to the walk root. */
  relativePath: string;
  kind: 'file' | 'directory' | 'symlink';
}

export interface WalkResult {
  entries: DiscoveredPath[];
  diagnostics: Diagnostic[];
}

/**
 * Walks a known runtime search area, recording symlinks instead of following
 * them and never reading file contents. Unknown items inside known areas are
 * preserved, not silently ignored (design doc §10.2).
 */
export async function walkHarnessPaths(
  _root: string,
  _subpaths: readonly string[],
): Promise<WalkResult> {
  notImplemented('harness path walk');
}
