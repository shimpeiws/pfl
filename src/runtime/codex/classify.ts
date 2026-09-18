import type { FacetMappings, FindingKinds } from '../../classify/mappings.js';

/** The Codex kinds the core table does not carry (roadmap M9 #91). */
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
  'shell-environment': {
    facets: ['controls'],
    confidence: 'medium',
    reason: 'shapes the environment the agent sees',
  },
  'project-configuration': {
    facets: ['controls'],
    confidence: 'medium',
    reason: 'project trust and approval configuration',
  },
  'model-configuration': {
    facets: ['controls'],
    confidence: 'medium',
    reason: 'selects the model and reasoning behavior',
  },
  'compaction-controls': {
    facets: ['controls'],
    confidence: 'medium',
    reason: 'controls context and compaction',
  },
};

/** The kinds the findings rules key on, declared by the adapter (roadmap M9 #91). */
export const FINDING_KINDS: Partial<FindingKinds> = {
  instruction: ['instructions'],
  memory: ['memory'],
  permission: ['permissions'],
} as const;
