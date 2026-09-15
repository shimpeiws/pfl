import { resolveProjectContext } from '../discovery/project-identity.js';
import { listSnapshots, type StoredSnapshotSummary } from '../snapshot/store.js';
import type { Logger } from '../util/logger.js';

export interface SnapshotsOptions {
  json?: boolean;
}

/**
 * `pfl snapshots` (design doc §23): list stored snapshots for the current
 * project, newest first.
 */
export async function runSnapshots(
  cwd: string,
  options: SnapshotsOptions,
  logger: Logger,
): Promise<void> {
  const project = await resolveProjectContext(cwd);
  const { snapshots, diagnostics } = await listSnapshots(project.id);

  for (const diagnostic of diagnostics) {
    logger.warn(diagnostic.message, { code: diagnostic.code, path: diagnostic.path });
  }

  if (options.json) {
    logger.info('snapshots', { project: project.id, snapshots });
    return;
  }

  if (snapshots.length === 0) {
    logger.info(`No snapshots stored for ${project.displayName}.`);
    return;
  }

  logger.info(`${snapshots.length} snapshot(s) for ${project.displayName}:`);
  for (const snapshot of snapshots) {
    logger.info(formatSnapshot(snapshot));
  }
}

function formatSnapshot(snapshot: StoredSnapshotSummary): string {
  const version = snapshot.runtime.version ?? 'unknown';
  return `${snapshot.id}  ${snapshot.capturedAt}  ${snapshot.runtime.id}@${version}  ${snapshot.completeness}`;
}
