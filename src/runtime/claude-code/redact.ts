import {
  COMMON_REDACTION_RULES,
  REDACTED,
  applyRedactionRules,
  type RedactionLevel,
  type RedactionRule,
} from '../../redact/common.js';

/**
 * Runtime-specific redaction layer for Claude Code (design doc §20). Composed
 * on top of the common policy; the common rules cover the general shapes, these
 * cover Claude Code–specific credential names and prefixes.
 */
const CLAUDE_CODE_REDACTION_RULES: readonly RedactionRule[] = [
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

const RULES: readonly RedactionRule[] = [...COMMON_REDACTION_RULES, ...CLAUDE_CODE_REDACTION_RULES];

/** Applies the common and Claude Code policies. Defaults to the safest tier. */
export function redactClaudeCode(value: string, level: RedactionLevel = 'persistence'): string {
  return applyRedactionRules(value, RULES, level);
}
