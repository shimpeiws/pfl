import type { FacetMappings, FindingKinds } from '../../classify/mappings.js';

/**
 * The Claude Code kinds the core table does not carry (roadmap M9 #91).
 * `commands` and `subagents` moved to the core table once OpenCode spelled them
 * too; only Claude Code's own `approval-policy` and `output-style` remain here.
 */
export const FACET_MAPPINGS: FacetMappings = {
  'approval-policy': { facets: ['controls'], confidence: 'high', reason: 'constrains approval' },
  'output-style': { facets: ['instructions'], confidence: 'medium', reason: 'shapes output style' },
};

/**
 * The kinds the findings rules key on, declared by the adapter that emits them
 * so `findings.ts` carries no hardcoded kind spelling (roadmap M9 #91).
 */
export const FINDING_KINDS: Partial<FindingKinds> = {
  instruction: ['instructions'],
  memory: ['memory'],
  permission: ['permissions'],
} as const;
