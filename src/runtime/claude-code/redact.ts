import {
  COMMON_REDACTION_RULES,
  applyRedactionRules,
  type RedactionLevel,
} from '../../redact/common.js';
import { CLAUDE_CODE_REDACTION_RULES } from '../../redact/rules.js';

/**
 * Runtime-specific redaction layer for Claude Code (design doc §20). Composed
 * on top of the common policy; the common rules cover the general shapes, the
 * Claude Code rules cover runtime-specific credential names and prefixes.
 */
const RULES = [...COMMON_REDACTION_RULES, ...CLAUDE_CODE_REDACTION_RULES];

/** Applies the common and Claude Code policies. Defaults to the safest tier. */
export function redactClaudeCode(value: string, level: RedactionLevel = 'persistence'): string {
  return applyRedactionRules(value, RULES, level);
}
