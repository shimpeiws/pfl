import { notImplemented } from './exit-codes.js';
import type { Logger } from '../util/logger.js';

export interface GraphOptions {
  snapshot?: string;
  json?: boolean;
}

/**
 * `pfl graph [--snapshot <id>]` (design doc §23, §27): render provenance and
 * resolution for the initial graph. Advanced semantic dependency graphs are
 * deferred.
 */
export async function runGraph(
  _cwd: string,
  _options: GraphOptions,
  _logger: Logger,
): Promise<void> {
  notImplemented('pfl graph');
}
