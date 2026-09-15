import { getAdapter } from '../runtime/registry.js';
import type { Logger } from '../util/logger.js';
import { notImplemented } from './exit-codes.js';

export interface InspectOptions {
  runtime: string;
  json?: boolean;
}

/**
 * `pfl inspect --runtime <id>` (design doc §9, §23, §25): discover and resolve
 * one runtime's harness, persist immutable snapshots, and print a summary.
 */
export async function runInspect(
  _cwd: string,
  options: InspectOptions,
  _logger: Logger,
): Promise<void> {
  // Validate the requested runtime before any work; unknown ids fail with the
  // runtime-unsupported exit code.
  getAdapter(options.runtime);
  notImplemented('pfl inspect');
}
