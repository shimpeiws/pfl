import { COMMON_REDACTION_RULES, REDACTED, type RedactionRule } from './common.js';

/**
 * Runtime-specific redaction rules (design doc §20). Kept as data here rather
 * than inside each adapter package so the output layer can compose them without
 * depending on a runtime: redacting with another runtime's rules can only
 * over-mask, which is safe.
 */

/** Claude Code-specific credential names and prefixes. */
export const CLAUDE_CODE_REDACTION_RULES: readonly RedactionRule[] = [
  {
    from: 'display',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
    replacement: REDACTED,
  },
  {
    from: 'display',
    pattern:
      /\b((?:ANTHROPIC|CLAUDE_CODE)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET)[A-Z0-9_]*\s*[:=]\s*)\S+/gi,
    replacement: `$1${REDACTED}`,
  },
];

/** Codex- and OpenAI-specific credential names and prefixes. */
export const CODEX_REDACTION_RULES: readonly RedactionRule[] = [
  {
    from: 'display',
    pattern: /\bsess-[A-Za-z0-9_-]{8,}/g,
    replacement: REDACTED,
  },
  {
    from: 'display',
    pattern: /\b((?:OPENAI|CODEX)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET)[A-Z0-9_]*\s*[:=]\s*)\S+/gi,
    replacement: `$1${REDACTED}`,
  },
];

/** Every policy: common plus every runtime's rules. */
export const ALL_REDACTION_RULES: readonly RedactionRule[] = [
  ...COMMON_REDACTION_RULES,
  ...CLAUDE_CODE_REDACTION_RULES,
  ...CODEX_REDACTION_RULES,
];
