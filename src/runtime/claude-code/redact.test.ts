import { describe, expect, it } from 'vitest';
import { redactClaudeCode } from './redact.js';

describe('redactClaudeCode', () => {
  it('redacts Anthropic and Claude Code credentials', () => {
    expect(redactClaudeCode('sk-ant-abcdefghijklmnop')).toBe('[redacted]');
    expect(redactClaudeCode('CLAUDE_CODE_OAUTH_TOKEN=abcdefghijklmnop')).toBe(
      'CLAUDE_CODE_OAUTH_TOKEN=[redacted]',
    );
  });

  it('still applies the common policy', () => {
    expect(redactClaudeCode('Authorization: Bearer abcdefghijklmnop')).toBe(
      'Authorization: [redacted]',
    );
  });

  it('leaves ordinary harness text untouched', () => {
    expect(redactClaudeCode('A skill named foo.')).toBe('A skill named foo.');
  });
});
