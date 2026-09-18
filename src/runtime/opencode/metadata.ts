/**
 * OpenCode safe-metadata allowlist (design doc §19; model doc §5.1). Only these
 * fields may be persisted; `filterToAllowlist` drops everything else, so an
 * unknown field is never persisted automatically.
 *
 * Structural facts only — never instruction text, config values, provider
 * credentials, tool or MCP command arguments, environment values, or the
 * declared target of an `instructions`/`references` entry. Counts, names, key
 * names, booleans, and lengths only.
 */
export const OPENCODE_SAFE_METADATA_ALLOWLIST: readonly string[] = [
  // Frontmatter / element-directory facts.
  'format',
  'hasFrontmatter',
  'frontmatterKeys',
  'descriptionLength',
  'toolNames',
  'agentMode',
  // Config-derived structural facts.
  'serverNames',
  'pluginNames',
  'pluginTargetKinds',
  'pluginCount',
  'allowCount',
  'askCount',
  'denyCount',
  'topLevelRuleCount',
  'model',
  'smallModel',
  'providerNames',
  'disabledProviderCount',
  'enabledProviderCount',
  'compactionConfigured',
  'toolOutputConfigured',
  'shellConfigured',
  'projectConfigKeys',
  'toolingKeys',
  // Declared targets are recorded as a kind, never as the target itself.
  'declaredTargetKind',
];
