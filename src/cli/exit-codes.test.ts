import { describe, expect, it } from 'vitest';
import { EXIT_CODES } from './exit-codes.js';

describe('EXIT_CODES', () => {
  it('pins each code to its number', () => {
    expect(EXIT_CODES).toEqual({
      SUCCESS: 0,
      CONFIG_ERROR: 2,
      RUNTIME_UNSUPPORTED: 3,
      INSPECTION_FAILED: 4,
      CONSENT_REQUIRED: 5,
      SNAPSHOT_STORE_FAILED: 6,
    });
  });

  it('gives every code a distinct number', () => {
    const values = Object.values(EXIT_CODES);
    expect(new Set(values).size).toBe(values.length);
  });
});
