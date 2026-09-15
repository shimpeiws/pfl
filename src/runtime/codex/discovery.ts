import { notImplemented } from '../../cli/exit-codes.js';
import type { ObservedSnapshot } from '../../core/observed.js';
import type { AccessPolicy, ProjectContext } from '../types.js';

/**
 * Discover Codex harness elements and build an immutable ObservedSnapshot
 * (design doc §10, §31.2). Must obey the read-only, no-execution, no-symlink
 * traversal, and safe-metadata invariants (design doc §19).
 */
export async function discoverCodex(
  _project: ProjectContext,
  _access: AccessPolicy,
): Promise<ObservedSnapshot> {
  notImplemented('Codex discovery');
}
