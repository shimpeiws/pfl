import {
  COMMON_REDACTION_RULES,
  REDACTED,
  applyRedactionRules,
  type RedactionLevel,
  type RedactionRule,
} from '../../redact/common.js';

/**
 * Runtime-specific redaction layer for Codex (design doc §20). Composed on top
 * of the common policy; the common rules cover the general shapes, these cover
 * Codex — and OpenAI — specific credential names and prefixes.
 */
const CODEX_REDACTION_RULES: readonly RedactionRule[] = [
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

const RULES: readonly RedactionRule[] = [...COMMON_REDACTION_RULES, ...CODEX_REDACTION_RULES];

/** Applies the common and Codex policies. Defaults to the safest tier. */
export function redactCodex(value: string, level: RedactionLevel = 'persistence'): string {
  return applyRedactionRules(value, RULES, level);
}
