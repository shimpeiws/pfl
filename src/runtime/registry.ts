import { EXIT_CODES, PflError } from '../cli/exit-codes.js';
import { ClaudeCodeAdapter } from './claude-code/index.js';
import { CodexAdapter } from './codex/index.js';
import type { RuntimeAdapter } from './types.js';

/**
 * The only module allowed to import concrete RuntimeAdapters. Everything else
 * must go through `getAdapter(id)`, so the core stays adapter-agnostic
 * (design doc §8).
 */
const ADAPTERS: Record<string, () => RuntimeAdapter> = {
  'claude-code': () => new ClaudeCodeAdapter(),
  codex: () => new CodexAdapter(),
};

export function getAdapter(id: string): RuntimeAdapter {
  const factory = ADAPTERS[id];
  if (!factory) {
    throw new PflError(`unknown runtime: ${id}`, EXIT_CODES.RUNTIME_UNSUPPORTED);
  }
  return factory();
}

export function listRuntimeIds(): string[] {
  return Object.keys(ADAPTERS);
}
