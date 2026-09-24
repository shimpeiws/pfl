import { describe, expect, it } from 'vitest';
import {
  redactDiagnostic,
  redactFreeText,
  redactHomePath,
  redactPath,
  redactingLogger,
} from './output.js';

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

describe('redactDiagnostic', () => {
  it('keeps an embedded long path in the message intact (#179)', () => {
    // The high-entropy rule's character class includes '/', so an assembled
    // message like this used to lose the path at export/persistence level.
    const longPath = `~/.claude/plugins/cache/pstack-claude/pstack/0.9.15/skills/architect/SKILL.md`;
    const diagnostic = {
      severity: 'warning' as const,
      code: 'duplicate-element-name',
      message: `skills name "architect" is defined more than once (${longPath}, ~/.claude/skills/architect/SKILL.md)`,
    };

    const redacted = redactDiagnostic(diagnostic, 'persistence', { home: HOME });

    expect(redacted.message).toContain(longPath);
    expect(redacted.message).not.toContain('[redacted]');
  });

  it('still strips the home prefix from a path embedded in the message', () => {
    const diagnostic = {
      severity: 'info' as const,
      code: 'path-not-found',
      message: `could not read ${HOME}/.letta/worktrees/opencode-scope-model/file.md`,
    };

    const redacted = redactDiagnostic(diagnostic, 'persistence', { home: HOME });

    expect(redacted.message).toBe('could not read ~/.letta/worktrees/opencode-scope-model/file.md');
  });

  it('still masks a known token shape inside the message', () => {
    const diagnostic = {
      severity: 'warning' as const,
      code: 'example',
      message: `could not read key sk-ant-abcdefghijklmnop from file`,
    };

    const redacted = redactDiagnostic(diagnostic, 'export', { home: HOME });

    expect(redacted.message).not.toContain('sk-ant-abcdefghijklmnop');
  });

  it('masks an unlabelled high-entropy token at export and persistence', () => {
    // A secret-shaped fixture, not a real credential; the variable name carries
    // no keyword so the secret scanners do not flag the planted value.
    const candidate = 'Zx9k2pQ7mN4vR1sT8uW3yA6bC0dE5fG7hJ2kL9mN4pQ';
    const diagnostic = {
      severity: 'warning' as const,
      code: 'example',
      message: `harness signalled ${candidate} near ~/.claude/skills/architect/SKILL.md`,
    };

    for (const level of ['export', 'persistence'] as const) {
      const redacted = redactDiagnostic(diagnostic, level, { home: HOME });
      expect(redacted.message).not.toContain(candidate);
      expect(redacted.message).toContain('~/.claude/skills/architect/SKILL.md');
    }

    const displayed = redactDiagnostic(diagnostic, 'display', { home: HOME });
    expect(displayed.message).toContain(candidate);
  });

  it('masks a slash-bearing high-entropy token instead of mistaking it for a path', () => {
    // A secret-shaped fixture, not a real credential. Base64 output can
    // contain '/', which must not exempt the token from the catch-all.
    const candidate = 'Zx9k2pQ7mN4vR1sT8uW3yA6bC0dE/5fG7hJ2kL9mN4pQ';
    const diagnostic = {
      severity: 'warning' as const,
      code: 'example',
      message: `harness signalled ${candidate}`,
    };

    for (const level of ['export', 'persistence'] as const) {
      expect(redactDiagnostic(diagnostic, level, { home: HOME }).message).not.toContain(candidate);
    }
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
