import { describe, expect, it } from 'vitest';
import { sha256Digest } from './hash.js';

describe('sha256Digest', () => {
  it('returns a prefixed hex digest of known content', () => {
    expect(sha256Digest('abc')).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is stable across calls', () => {
    expect(sha256Digest('same')).toBe(sha256Digest('same'));
  });
});
