import { describe, expect, it } from 'vitest';
import { HARNESS_FACETS, isHarnessFacet } from './facets.js';

describe('harness facets', () => {
  it('exposes the initial six facets in a stable order', () => {
    expect(HARNESS_FACETS).toEqual([
      'instructions',
      'knowledge',
      'memory',
      'actions',
      'delegation',
      'controls',
    ]);
  });

  it('recognizes known facets and rejects unknown strings', () => {
    expect(isHarnessFacet('instructions')).toBe(true);
    expect(isHarnessFacet('telepathy')).toBe(false);
  });
});
