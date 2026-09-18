import { describe, expect, it } from 'vitest';
import { readJsonc } from './jsonc.js';

describe('readJsonc', () => {
  it('parses line comments, block comments, and trailing commas', async () => {
    const text = [
      '{',
      '  // a line comment',
      '  "model": "anthropic/claude",',
      '  /* a block',
      '     comment */',
      '  "mcp": { "a": {} },',
      '}',
    ].join('\n');

    expect(readJsonc(text)).toEqual({
      value: { model: 'anthropic/claude', mcp: { a: {} } },
      malformed: false,
    });
  });

  it('does not treat a comment marker inside a string as a comment', () => {
    const text = '{ "url": "https://example.com/a//b", "note": "a,}" }';

    expect(readJsonc(text).value).toEqual({
      url: 'https://example.com/a//b',
      note: 'a,}',
    });
  });

  it('respects an escaped quote in a string', () => {
    const text = '{ "a": "he said \\"//not a comment\\"", }';

    expect(readJsonc(text).value).toEqual({ a: 'he said "//not a comment"' });
  });

  it('reports malformed input rather than throwing', () => {
    expect(readJsonc('{ "a": }')).toMatchObject({ malformed: true, value: undefined });
    expect(readJsonc('')).toMatchObject({ malformed: true });
    expect(readJsonc('{ "a": 1 } trailing')).toMatchObject({ malformed: true });
  });

  it('does not join tokens across a block comment', () => {
    // Removing `/*c*/` to nothing would yield `{"a":12}` — valid, but not the
    // document the runtime would reject. A separating space keeps it malformed.
    expect(readJsonc('{"a":1/*c*/2}')).toMatchObject({ malformed: true });
    expect(readJsonc('{"a":/*c*/1}')).toEqual({ value: { a: 1 }, malformed: false });
  });

  it('parses an empty object', () => {
    expect(readJsonc('{ /* nothing */ }')).toEqual({ value: {}, malformed: false });
  });
});
