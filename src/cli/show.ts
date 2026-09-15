import { notImplemented } from './exit-codes.js';
import type { Logger } from '../util/logger.js';

export interface ShowOptions {
  json?: boolean;
}

/**
 * `pfl show <element-id>` (design doc §23): drill into one element's observed
 * facts, resolved facts, and derived interpretation.
 */
export async function runShow(
  _cwd: string,
  _elementId: string,
  _options: ShowOptions,
  _logger: Logger,
): Promise<void> {
  notImplemented('pfl show');
}
