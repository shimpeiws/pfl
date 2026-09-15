import { describe, expect, it } from 'vitest';
import { redactCodex } from './redact.js';

describe('redactCodex', () => {
  it('redacts OpenAI and Codex credentials', () => {
    expect(redactCodex('sess-abcdefghijklmnop')).toBe('[redacted]');
    expect(redactCodex('OPENAI_API_KEY=abcdefghijklmnop')).toBe('OPENAI_API_KEY=[redacted]');
  });

  it('still applies the common policy', () => {
    expect(redactCodex('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: [redacted]');
  });

  it('leaves ordinary harness text untouched', () => {
    expect(redactCodex('A custom agent named foo.')).toBe('A custom agent named foo.');
  });
});
