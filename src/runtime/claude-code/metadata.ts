/**
 * Claude Code safe-metadata allowlist (design doc §19). Only these fields may
 * be persisted; `filterToAllowlist` drops everything else, so an unknown field
 * is never persisted automatically.
 *
 * Structural facts only — never instruction text, memory content, environment
 * values, or secret values.
 */
export const CLAUDE_CODE_SAFE_METADATA_ALLOWLIST: readonly string[] = [
  'kind',
  'format',
  'sizeBytes',
  'isSymlink',
  'entryCount',
  'hasFrontmatter',
  'frontmatterKeys',
  'descriptionLength',
  'commandCount',
  'eventNames',
  'toolNames',
  'permissionMode',
  'approvalPolicy',
  'allowCount',
  'denyCount',
  'askCount',
  'serverNames',
  'outputStyle',
  'enabledPluginCount',
  'model',
];
