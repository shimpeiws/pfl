import { notImplemented } from '../cli/exit-codes.js';
import type { ProjectContext } from '../runtime/types.js';

/**
 * Project identity (design doc §16).
 *
 * For Git repositories: canonical remote URL + canonical repository root.
 * For non-Git directories: canonical absolute path. A display name is derived
 * automatically; user aliases are deferred.
 */
export async function resolveProjectContext(_cwd: string): Promise<ProjectContext> {
  notImplemented('project identity resolution');
}
