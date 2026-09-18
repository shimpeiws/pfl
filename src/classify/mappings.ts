import type { HarnessFacet } from '../core/facets.js';
import type { ClassificationConfidence } from '../core/interpretation.js';

/**
 * Kind-to-facet mappings, owned in two layers (roadmap M9 #91). The **core**
 * table holds the kinds two runtimes spell the same way plus the shared
 * `runtime-provided-instructions`; each adapter contributes the kinds only it
 * emits. The runtime registry merges them, so an adapter can introduce a kind
 * without editing `src/classify/`.
 *
 * Facets are additive; a mapped kind's `confidence` is a closed scale. An
 * unknown kind is recorded as unclassified, never guessed.
 */
export interface FacetMapping {
  facets: readonly HarnessFacet[];
  confidence: ClassificationConfidence;
  reason: string;
}

export type FacetMappings = Record<string, FacetMapping>;

/**
 * Kinds two runtimes spell the same way, plus the shared opaque builtin layer.
 * `runtime-provided-instructions` is mapped but its contents are opaque, so its
 * confidence is `unknown`.
 */
export const CORE_FACET_MAPPINGS: FacetMappings = {
  instructions: { facets: ['instructions'], confidence: 'high', reason: 'defines agent behavior' },
  rules: { facets: ['instructions'], confidence: 'medium', reason: 'instruction-like rule' },
  skills: {
    facets: ['knowledge', 'actions'],
    confidence: 'medium',
    reason: 'consultable capability the agent can invoke',
  },
  plugin: {
    facets: ['knowledge', 'actions', 'delegation'],
    confidence: 'medium',
    reason: 'supplies skills, commands, agents, or hooks',
  },
  hooks: {
    facets: ['controls'],
    confidence: 'high',
    reason: 'event pipeline that shapes trajectory',
  },
  permissions: { facets: ['controls'], confidence: 'high', reason: 'constrains tool use' },
  'mcp-configuration': {
    facets: ['actions'],
    confidence: 'medium',
    reason: 'provides external capabilities',
  },
  memory: { facets: ['memory'], confidence: 'high', reason: 'persistent carried-forward state' },
  'runtime-provided-instructions': {
    facets: ['instructions'],
    confidence: 'unknown',
    reason: 'runtime-provided layer; contents are opaque',
  },
};

/** Merges adapter contributions over the core table; later entries win on a kind. */
export function mergeFacetMappings(...tables: readonly FacetMappings[]): FacetMappings {
  return Object.assign({}, ...tables) as FacetMappings;
}

/**
 * The kinds a finding rule keys on, declared rather than spelled inside
 * `findings.ts` (roadmap M9 #91). An adapter satisfies a rule by listing the
 * kinds it emits for that role.
 */
export interface FindingKinds {
  /** `subtree-specific-instruction` */
  instruction: readonly string[];
  /** `memory-enabled` */
  memory: readonly string[];
  /** `broad-tool-access` */
  permission: readonly string[];
}

/** The shared spellings, used when a caller supplies no adapter contribution. */
export const CORE_FINDING_KINDS: FindingKinds = {
  instruction: ['instructions'],
  memory: ['memory'],
  permission: ['permissions'],
};

/** Unions adapter contributions with the core spellings. */
export function mergeFindingKinds(...tables: readonly Partial<FindingKinds>[]): FindingKinds {
  const merged: Record<'instruction' | 'memory' | 'permission', string[]> = {
    instruction: [...CORE_FINDING_KINDS.instruction],
    memory: [...CORE_FINDING_KINDS.memory],
    permission: [...CORE_FINDING_KINDS.permission],
  };
  for (const table of tables) {
    for (const role of ['instruction', 'memory', 'permission'] as const) {
      for (const kind of table[role] ?? []) {
        if (!merged[role].includes(kind)) merged[role].push(kind);
      }
    }
  }
  return merged;
}
