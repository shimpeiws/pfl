import { notImplemented } from './exit-codes.js';
import type { Logger } from '../util/logger.js';

export interface ReportOptions {
  snapshot?: string;
  json?: boolean;
}

/**
 * `pfl report [--snapshot <id>]` (design doc §23, §26): interpret structure
 * without evaluating whether the harness is good or bad.
 */
export async function runReport(
  _cwd: string,
  _options: ReportOptions,
  _logger: Logger,
): Promise<void> {
  notImplemented('pfl report');
}
