import { describe, expect, it } from 'vitest';
import { canonicalJsonStringify } from './json.js';

describe('canonicalJsonStringify', () => {
  it('sorts object keys recursively regardless of insertion order', () => {
    const a = { b: 1, a: { d: 2, c: 3 } };
    const b = { a: { c: 3, d: 2 }, b: 1 };
    expect(canonicalJsonStringify(a)).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
  });

  it('preserves array order', () => {
    expect(canonicalJsonStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('keeps a literal __proto__ key as an own property', () => {
    const withProtoKey = JSON.parse('{"__proto__":{"x":1}}') as unknown;
    expect(canonicalJsonStringify(withProtoKey)).toBe('{"__proto__":{"x":1}}');
  });
});
