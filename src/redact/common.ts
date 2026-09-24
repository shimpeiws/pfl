/**
 * Common redaction policy (design doc §20). Covers token-like values, secrets,
 * passwords, authorization headers, URL credentials, sensitive query
 * parameters, environment values, and unknown sensitive-looking values.
 * Adapters add runtime-specific rules on top.
 *
 * Display and persistence differ (design doc §19): interactive terminal output
 * may be richer, machine-readable export is safer, and snapshot persistence is
 * the safest. A rule declares the lowest level at which it redacts; callers
 * that persist pick `persistence` (the default), callers that print to a
 * terminal pick `display`.
 *
 * Digests and structural metadata are not passed through here — they are
 * produced, not copied from text, so the high-entropy heuristic never destroys
 * a legitimate digest.
 */

export type RedactionLevel = 'display' | 'export' | 'persistence';

const LEVEL_RANK: Record<RedactionLevel, number> = { display: 0, export: 1, persistence: 2 };

export const REDACTED = '[redacted]';

/**
 * The catch-all for unknown high-entropy values, separated out so callers that
 * must protect embedded paths (diagnostic messages) can apply it selectively
 * instead of dropping it. Its character class includes `/`, so applying it to
 * a whole path-bearing string would destroy the path (#179).
 */
export const HIGH_ENTROPY_RULE: RedactionRule = {
  from: 'export',
  pattern: /\b[A-Za-z0-9+/=_-]{32,}\b/g,
  replacement: REDACTED,
};

export interface RedactionRule {
  /** Lowest level at which this rule redacts. */
  from: RedactionLevel;
  pattern: RegExp;
  replacement: string;
}

export const COMMON_REDACTION_RULES: readonly RedactionRule[] = [
  // PEM private-key blocks (multi-line) before anything line-oriented.
  {
    from: 'display',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: REDACTED,
  },
  // Authorization headers, with or without an explicit scheme word.
  {
    from: 'display',
    pattern: /(\bauthorization\b\s*[:=]\s*)(?:\w+\s+)?\S+/gi,
    replacement: `$1${REDACTED}`,
  },
  {
    from: 'display',
    pattern: /\b(Bearer|Basic|Token|Digest)\s+[A-Za-z0-9\-._~+/]{8,}=*/g,
    replacement: `$1 ${REDACTED}`,
  },
  // URL credentials: https://user:pass@host -> https://[redacted]@host
  {
    from: 'display',
    pattern: /(\w+:\/\/)[^/\s:@]+:[^/\s@]+@/g,
    replacement: `$1${REDACTED}@`,
  },
  // Sensitive query parameters.
  {
    from: 'display',
    pattern:
      /([?&](?:token|access[_-]?token|api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|pwd|auth|authorization|private[_-]?key)=)[^&#\s]*/gi,
    replacement: `$1${REDACTED}`,
  },
  // Environment-style sensitive assignments (SCREAMING_CASE keys).
  {
    from: 'display',
    pattern:
      /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*\s*[:=]\s*)["']?[^\s"',;&]+/gi,
    replacement: `$1${REDACTED}`,
  },
  // Known token shapes.
  {
    from: 'display',
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g,
    replacement: REDACTED,
  },
  // Sensitive key = value in any case.
  {
    from: 'display',
    pattern:
      /\b((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*)["']?[^\s"',;&]+/gi,
    replacement: `$1${REDACTED}`,
  },
  // Unknown high-entropy values: only at export/persistence, where the safer
  // tier applies. Long hex/base64-ish runs are treated as secrets.
  HIGH_ENTROPY_RULE,
];

/** Applies the common policy. Defaults to the safest (`persistence`) tier. */
export function redactText(value: string, level: RedactionLevel = 'persistence'): string {
  return applyRedactionRules(value, COMMON_REDACTION_RULES, level);
}

/** Applies a rule set at the given level; a rule runs when its `from` is reached. */
export function applyRedactionRules(
  value: string,
  rules: readonly RedactionRule[],
  level: RedactionLevel = 'persistence',
): string {
  const rank = LEVEL_RANK[level];
  let result = value;
  for (const rule of rules) {
    if (LEVEL_RANK[rule.from] <= rank) {
      result = result.replace(rule.pattern, rule.replacement);
    }
  }
  return result;
}
