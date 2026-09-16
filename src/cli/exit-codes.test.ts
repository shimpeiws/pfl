import { describe, expect, it } from 'vitest';
import { EXIT_CODES, PflError, notImplemented, type ExitCode } from './exit-codes.js';

function exitCodeOf(fn: () => void): ExitCode | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof PflError ? error.exitCode : undefined;
  }
  return undefined;
}

describe('EXIT_CODES', () => {
  it('pins each code to its number', () => {
    expect(EXIT_CODES).toEqual({
      SUCCESS: 0,
      CONFIG_ERROR: 2,
      RUNTIME_UNSUPPORTED: 3,
      INSPECTION_FAILED: 4,
      CONSENT_REQUIRED: 5,
      SNAPSHOT_STORE_FAILED: 6,
      NOT_IMPLEMENTED: 7,
    });
  });

  it('gives every code a distinct number', () => {
    const values = Object.values(EXIT_CODES);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('notImplemented', () => {
  it('exits with NOT_IMPLEMENTED, not a config error', () => {
    expect(exitCodeOf(() => notImplemented('pfl inspect'))).toBe(EXIT_CODES.NOT_IMPLEMENTED);
  });
});
