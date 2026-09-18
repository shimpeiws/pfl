import {
  COMMON_REDACTION_RULES,
  applyRedactionRules,
  type RedactionLevel,
} from '../../redact/common.js';
import { OPENCODE_REDACTION_RULES } from '../../redact/rules.js';

/**
 * Runtime-specific redaction layer for OpenCode (design doc §20). Composed on
 * top of the common policy; the common rules cover the general shapes, the
 * OpenCode rules cover the provider-prefixed credential names OpenCode config
 * may carry. The backstop is not the only thing between a config value and the
 * store: the adapter persists counts, names, and key names, never a value.
 */
const RULES = [...COMMON_REDACTION_RULES, ...OPENCODE_REDACTION_RULES];

/** Applies the common and OpenCode policies. Defaults to the safest tier. */
export function redactOpencode(value: string, level: RedactionLevel = 'persistence'): string {
  return applyRedactionRules(value, RULES, level);
}
