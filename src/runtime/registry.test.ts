import { describe, expect, it } from 'vitest';
import { PflError, EXIT_CODES } from '../cli/exit-codes.js';
import { getAdapter, listRuntimeIds } from './registry.js';

describe('runtime registry', () => {
  it('lists the initial runtimes', () => {
    expect(listRuntimeIds()).toEqual(['claude-code', 'codex', 'opencode']);
  });

  it('returns an adapter whose id matches the request', () => {
    expect(getAdapter('claude-code').id()).toBe('claude-code');
    expect(getAdapter('codex').id()).toBe('codex');
    expect(getAdapter('opencode').id()).toBe('opencode');
  });

  it('rejects an unknown runtime with the runtime-unsupported exit code', () => {
    try {
      getAdapter('bogus');
      expect.unreachable('getAdapter should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PflError);
      expect((error as PflError).exitCode).toBe(EXIT_CODES.RUNTIME_UNSUPPORTED);
    }
  });
});
