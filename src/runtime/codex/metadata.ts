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
  'format',
  'hasFrontmatter',
  'frontmatterKeys',
  'descriptionLength',
  'toolNames',
  'eventNames',
  'approvalMode',
  'sandboxMode',
  'networkAccess',
  'writableRootCount',
  'trustLevel',
  'inheritMode',
  'setKeyCount',
  'model',
  'reasoningEffort',
  'serviceTier',
  'serverNames',
  'pluginNames',
  'marketplaceNames',
  'enabledPluginCount',
];
