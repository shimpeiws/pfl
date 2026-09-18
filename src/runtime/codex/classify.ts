import type { FacetMappings, FindingKinds } from '../../classify/mappings.js';

/**
 * The Codex kinds the core table does not carry (roadmap M9 #91).
 * `model-configuration`, `compaction-controls`, `shell-environment`, and
 * `project-configuration` moved to the core table once OpenCode spelled them
 * too; only Codex's own `fallback-instructions` and `approval-sandbox` remain.
 */
export const FACET_MAPPINGS: FacetMappings = {
  'fallback-instructions': {
    facets: ['instructions'],
    confidence: 'medium',
    reason: 'highest-precedence instruction file (replaces AGENTS.md in its directory)',
  },
  'approval-sandbox': {
    facets: ['controls'],
    confidence: 'high',
    reason: 'constrains approval and sandboxing',
  },
};

/** The kinds the findings rules key on, declared by the adapter (roadmap M9 #91). */
export const FINDING_KINDS: Partial<FindingKinds> = {
  instruction: ['instructions'],
  memory: ['memory'],
  permission: ['permissions'],
} as const;
