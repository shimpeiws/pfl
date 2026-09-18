import type { FacetMappings, FindingKinds } from '../../classify/mappings.js';

/**
 * The OpenCode kinds the core table does not carry (model doc §7; roadmap M9
 * #91). `commands` and `subagents` are shared with Claude Code and
 * `model-configuration`, `compaction-controls`, `shell-environment`, and
 * `project-configuration` with Codex, so those live in the core table; only the
 * kinds OpenCode alone emits remain here.
 */
export const FACET_MAPPINGS: FacetMappings = {
  agents: {
    facets: ['delegation', 'controls'],
    confidence: 'high',
    reason: 'primary agent that sets delegation and controls',
  },
  tools: { facets: ['actions'], confidence: 'medium', reason: 'custom tool the agent can call' },
  'tooling-configuration': {
    facets: ['controls'],
    confidence: 'medium',
    reason: 'formatter and language-server configuration',
  },
  references: {
    facets: ['knowledge'],
    confidence: 'unknown',
    reason: 'declared knowledge target; contents are opaque',
  },
};

/**
 * The kinds the findings rules key on, declared by the adapter that emits them
 * so `findings.ts` carries no hardcoded kind spelling (roadmap M9 #91). OpenCode
 * has no memory surface (model doc §7), so the memory role is empty.
 */
export const FINDING_KINDS: Partial<FindingKinds> = {
  instruction: ['instructions'],
  memory: [],
  permission: ['permissions'],
} as const;
