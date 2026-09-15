import { notImplemented } from './exit-codes.js';
import type { Logger } from '../util/logger.js';

export interface SnapshotsOptions {
  json?: boolean;
}

/**
 * `pfl snapshots` (design doc §23): list stored snapshots for the current
 * project, newest first.
 */
export async function runSnapshots(
  _cwd: string,
  _options: SnapshotsOptions,
  _logger: Logger,
): Promise<void> {
  notImplemented('pfl snapshots');
}
