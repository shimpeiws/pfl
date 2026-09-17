import type { HarnessFacet } from '../core/facets.js';
import type {
  ClassificationConfidence,
  ElementInterpretation,
  HarnessStats,
  Interpretation,
} from '../core/interpretation.js';
import type { ObservedElement, ObservedSnapshot } from '../core/observed.js';
import type { ResolvedSnapshot } from '../core/resolved.js';

/**
 * Deterministic, local, LLM-free semantic classification (design doc §6, §21).
 * Each resolved element is mapped to facets from its *native kind* and
 * resolution facts — never from natural-language content — so the same snapshot
 * always yields the same interpretation. Native facts stay authoritative when a
 * classification is imperfect, and an element the table does not know gets
 * `unknown` confidence rather than a guessed facet.
 *
 * The mapping is data-driven: adding a facet or changing a mapping is a table
 * edit plus a `CLASSIFIER_VERSION` bump. Interpretations are recomputed rather
 * than persisted, so a mapping change does not invalidate stored data.
 */

export const CLASSIFIER_ID = 'pfl-native';
export const CLASSIFIER_VERSION = '4';

interface FacetMapping {
  facets: readonly HarnessFacet[];
  confidence: ClassificationConfidence;
  reason: string;
}

/**
 * Native kind -> facets. Facets are additive; an unknown kind is recorded as
 * unclassified, never guessed. `runtime-provided-instructions` is mapped but its
 * contents are opaque, so its confidence is `unknown`.
 */
const FACETS_BY_KIND: Record<string, FacetMapping> = {
  instructions: { facets: ['instructions'], confidence: 'high', reason: 'defines agent behavior' },
  'fallback-instructions': {
    facets: ['instructions'],
    confidence: 'medium',
    reason: 'highest-precedence instruction file (replaces AGENTS.md in its directory)',
  },
  rules: { facets: ['instructions'], confidence: 'medium', reason: 'instruction-like rule' },
  skills: {
    facets: ['knowledge', 'actions'],
    confidence: 'medium',
    reason: 'consultable capability the agent can invoke',
  },
  commands: { facets: ['actions'], confidence: 'high', reason: 'invokable command' },
  subagents: { facets: ['delegation'], confidence: 'high', reason: 'delegates work to a subagent' },
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
  'approval-policy': { facets: ['controls'], confidence: 'high', reason: 'constrains approval' },
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
  'output-style': { facets: ['instructions'], confidence: 'medium', reason: 'shapes output style' },
  'mcp-configuration': {
    facets: ['actions'],
    confidence: 'medium',
    reason: 'provides external capabilities',
  },
  memory: { facets: ['memory'], confidence: 'high', reason: 'persistent carried-forward state' },
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
  'runtime-provided-instructions': {
    facets: ['instructions'],
    confidence: 'unknown',
    reason: 'runtime-provided layer; contents are opaque',
  },
};

/**
 * Native kinds deliberately left without a facet mapping, so a kind the table
 * does not know is recorded as unclassified rather than guessed. Empty while
 * every kind an adapter declares has a deterministic mapping; a kind added
 * without a row must be named here or the kind-coverage test fails.
 */
export const UNCLASSIFIED_KINDS: ReadonlySet<string> = new Set<string>();

/** Whether `kind` has a deterministic facet mapping in `FACETS_BY_KIND`. */
export function classifiedKind(kind: string): boolean {
  return Object.hasOwn(FACETS_BY_KIND, kind);
}

export function classify(
  observed: ObservedSnapshot,
  resolved: ResolvedSnapshot,
): Pick<Interpretation, 'classifier' | 'elements' | 'stats'> {
  const observedById = new Map<string, ObservedElement>(
    observed.elements.map((element) => [element.id, element]),
  );

  // Classify every known id: an observed element that a (possibly incomplete or
  // older) resolved snapshot does not mention is still recorded, as unknown,
  // rather than dropped.
  const ids = new Set<string>([
    ...observed.elements.map((element) => element.id),
    ...resolved.elements.map((element) => element.id),
  ]);

  const elements: ElementInterpretation[] = [...ids]
    .map((id) => classifyElement(id as ElementInterpretation['elementId'], observedById.get(id)))
    .sort((a, b) => (a.elementId < b.elementId ? -1 : a.elementId > b.elementId ? 1 : 0));

  return {
    classifier: { id: CLASSIFIER_ID, version: CLASSIFIER_VERSION },
    elements,
    stats: computeStats(observed, resolved, elements),
  };
}

function classifyElement(
  elementId: ElementInterpretation['elementId'],
  observed: ObservedElement | undefined,
): ElementInterpretation {
  if (observed === undefined) {
    return {
      elementId,
      facets: [],
      confidence: 'unknown',
      reason: 'no matching observed element for this resolved id',
    };
  }
  const mapping = FACETS_BY_KIND[observed.native.kind];
  if (mapping === undefined) {
    return {
      elementId,
      facets: [],
      confidence: 'unknown',
      reason: `no deterministic facet mapping for native kind "${observed.native.kind}"`,
    };
  }
  return {
    elementId,
    facets: [...mapping.facets],
    confidence: mapping.confidence,
    reason: mapping.reason,
  };
}

function computeStats(
  observed: ObservedSnapshot,
  resolved: ResolvedSnapshot,
  elements: readonly ElementInterpretation[],
): HarnessStats {
  const byFacet: Partial<Record<HarnessFacet, number>> = {};
  for (const element of elements) {
    for (const facet of element.facets) {
      byFacet[facet] = (byFacet[facet] ?? 0) + 1;
    }
  }

  return {
    observed: observed.elements.length,
    effective: countStatus(resolved, 'effective'),
    shadowed: countStatus(resolved, 'shadowed'),
    conditional: countStatus(resolved, 'conditional'),
    opaque: observed.elements.filter((element) => element.inspectability === 'opaque').length,
    byFacet,
  };
}

function countStatus(resolved: ResolvedSnapshot, status: string): number {
  return resolved.elements.filter((element) => element.status === status).length;
}
