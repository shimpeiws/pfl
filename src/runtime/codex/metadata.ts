/**
 * Codex safe-metadata allowlist (design doc §19). Only these fields may be
 * persisted; `filterToAllowlist` drops everything else, so an unknown field is
 * never persisted automatically.
 *
 * Structural facts only — never instruction text, memory content, sandbox
 * command arguments, environment values, or secret values. Approval and sandbox
 * settings are read as values; they are never applied.
 */
export const CODEX_SAFE_METADATA_ALLOWLIST: readonly string[] = [
  'kind',
  'format',
  'sizeBytes',
  'isSymlink',
  'entryCount',
  'hasFrontmatter',
  'frontmatterKeys',
  'descriptionLength',
  'agentCount',
  'eventNames',
  'toolNames',
  'approvalMode',
  'sandboxMode',
  'model',
];
