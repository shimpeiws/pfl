import type { FacetMappings } from '../../classify/mappings.js';

/** The Claude Code kinds the core table does not carry (roadmap M9 #91). */
export const FACET_MAPPINGS: FacetMappings = {
  commands: { facets: ['actions'], confidence: 'high', reason: 'invokable command' },
  subagents: { facets: ['delegation'], confidence: 'high', reason: 'delegates work to a subagent' },
  'approval-policy': { facets: ['controls'], confidence: 'high', reason: 'constrains approval' },
  'output-style': { facets: ['instructions'], confidence: 'medium', reason: 'shapes output style' },
};

/**
 * The kinds the findings rules key on, declared by the adapter that emits them
 * so `findings.ts` carries no hardcoded kind spelling (roadmap M9 #91).
 */
export const FINDING_KINDS = {
  instruction: ['instructions'],
  memory: ['memory'],
  permission: ['permissions'],
} as const;
