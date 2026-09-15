import { describe, expect, it } from 'vitest';
import { filterToAllowlist } from './metadata.js';

describe('filterToAllowlist', () => {
  it('keeps only allowlisted keys', () => {
    const filtered = filterToAllowlist(
      { name: 'skill', description: 'do a thing', secret: 'should-not-persist' },
      ['name', 'description'],
    );
    expect(filtered).toEqual({ name: 'skill', description: 'do a thing' });
  });

  it('returns an empty object when nothing is allowlisted', () => {
    expect(filterToAllowlist({ a: 1 }, [])).toEqual({});
  });
});
