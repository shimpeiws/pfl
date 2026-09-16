import {
  COMMON_REDACTION_RULES,
  applyRedactionRules,
  type RedactionLevel,
} from '../../redact/common.js';
import { CODEX_REDACTION_RULES } from '../../redact/rules.js';

/**
 * Runtime-specific redaction layer for Codex (design doc §20). Composed on top
 * of the common policy; the common rules cover the general shapes, the Codex
 * rules cover runtime-specific credential names and prefixes.
 */
const RULES = [...COMMON_REDACTION_RULES, ...CODEX_REDACTION_RULES];

/** Applies the common and Codex policies. Defaults to the safest tier. */
export function redactCodex(value: string, level: RedactionLevel = 'persistence'): string {
  return applyRedactionRules(value, RULES, level);
}
