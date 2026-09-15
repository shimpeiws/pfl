import { notImplemented } from './exit-codes.js';
import type { Logger } from '../util/logger.js';

export interface DiffOptions {
  json?: boolean;
}

/**
 * `pfl diff <snapshot-a> <snapshot-b>` (design doc §23, §28): report
 * structural change, effective-state change, and semantic facet change.
 * Descriptive, not evaluative.
 */
export async function runDiff(
  _cwd: string,
  _snapshotA: string,
  _snapshotB: string,
  _options: DiffOptions,
  _logger: Logger,
): Promise<void> {
  notImplemented('pfl diff');
}
