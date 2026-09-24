import { describe, expect, it } from 'vitest';
import { redactFreeText, redactHomePath, redactPath, redactingLogger } from './output.js';

const HOME = '/Users/alice';

describe('redactHomePath', () => {
  it('replaces the raw home directory with ~', () => {
    expect(redactHomePath(`${HOME}/project`, HOME)).toBe('~/project');
  });

  it('replaces the /-to-dash encoded home used in Claude Code memory paths', () => {
    expect(redactHomePath('~/.claude/projects/-Users-alice-project/memory', HOME)).toBe(
      '~/.claude/projects/~-project/memory',
    );
  });

  it('does not touch a sibling whose name shares the home prefix', () => {
    expect(redactHomePath('/Users/alice2/file', HOME)).toBe('/Users/alice2/file');
    expect(redactHomePath('~/.claude/projects/-Users-alice2/memory', HOME)).toBe(
      '~/.claude/projects/-Users-alice2/memory',
    );
  });

  it('replaces the encoded home when the account name contains a dot', () => {
    // Claude Code encodes '.' like '/', so a dotted home (/Users/john.doe)
    // appears in memory paths as -Users-john-doe — the slash-only form would
    // leave the account name unredacted.
    expect(
      redactHomePath('~/.claude/projects/-Users-john-doe-work/memory', '/Users/john.doe'),
    ).toBe('~/.claude/projects/~-work/memory');
  });
});

describe('redactPath', () => {
  it('keeps a long path segment instead of high-entropy redacting it', () => {
    const long = `.claude/skills/${'a'.repeat(40)}/SKILL.md`;
    expect(redactPath(long, { home: HOME })).toBe(long);
  });

  it('strips the home prefix', () => {
    expect(redactPath(`${HOME}/x/y`, { home: HOME })).toBe('~/x/y');
  });

  it('applies runtime-specific rules to paths too', () => {
    const redacted = redactPath(`/tmp/sess-abcdefghijklmnop/token`, { home: HOME });
    expect(redacted).not.toContain('sess-abcdefghijklmnop');
  });
});

describe('redactFreeText', () => {
  it('redacts a token-like value', () => {
    const redacted = redactFreeText('token=sk-ant-abcdefghijklmnop', 'persistence', { home: HOME });
    expect(redacted).not.toContain('sk-ant-abcdefghijklmnop');
  });

  it('leaves ordinary text alone', () => {
    expect(redactFreeText('could not read file', 'persistence', { home: HOME })).toBe(
      'could not read file',
    );
  });
});

describe('redactingLogger', () => {
  it('redacts the message and a string data.path, leaving other fields', () => {
    const seen: string[] = [];
    const logger = {
      info: (message: string, data?: Record<string, unknown>) =>
        seen.push(`${message}|${JSON.stringify(data)}`),
      warn: () => undefined,
      error: () => undefined,
    };
    const out = redactingLogger(logger, 'display', { home: HOME });

    out.info(`read ${HOME}/project`, { path: `${HOME}/project/file`, code: 'x' });

    expect(seen[0]).not.toContain(HOME);
    expect(seen[0]).toContain('~/project');
    expect(seen[0]).toContain('"code":"x"');
  });
});
