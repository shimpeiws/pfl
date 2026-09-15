import { notImplemented } from './exit-codes.js';
import type { Logger } from '../util/logger.js';

export interface ListOptions {
  facet?: string;
  origin?: string;
  status?: string;
  json?: boolean;
}

/**
 * `pfl list [--facet <f>] [--origin <o>] [--status <s>]` (design doc §23):
 * list elements from the default `latest` snapshot, filtered by facet, origin,
 * or resolved status.
 */
export async function runList(_cwd: string, _options: ListOptions, _logger: Logger): Promise<void> {
  notImplemented('pfl list');
}
