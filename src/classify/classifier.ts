import type { HarnessFacet } from '../core/facets.js';
import type {
  ElementInterpretation,
  HarnessStats,
  Interpretation,
} from '../core/interpretation.js';
import type { ObservedElement, ObservedSnapshot } from '../core/observed.js';
import type { ResolvedSnapshot } from '../core/resolved.js';
import type { FacetMappings } from './mappings.js';

/**
 * Deterministic, local, LLM-free semantic classification (design doc §6, §21).
 * Each resolved element is mapped to facets from its *native kind* and
 * resolution facts — never from natural-language content — so the same snapshot
 * always yields the same interpretation. Native facts stay authoritative when a
 * classification is imperfect, and an element the table does not know gets
 * `unknown` confidence rather than a guessed facet.
 *
 * The mapping is data-driven and now adapter-owned (roadmap M9 #91): the runtime
 * registry merges each adapter's contribution over `CORE_FACET_MAPPINGS`, so an
 * adapter introduces a kind without editing this module. Changing a mapping, a
 * contributed mapping included, is a `CLASSIFIER_VERSION` bump.
 */

export const CLASSIFIER_ID = 'pfl-native';
export const CLASSIFIER_VERSION = '4';

/**
 * Native kinds deliberately left without a facet mapping, so a kind the table
 * does not know is recorded as unclassified rather than guessed. A kind added
 * without a mapping must be named here or the kind-coverage test fails.
 */
export const UNCLASSIFIED_KINDS: ReadonlySet<string> = new Set<string>();

/** Whether `kind` has a deterministic facet mapping in `mappings`. */
export function classifiedKind(kind: string, mappings: FacetMappings): boolean {
  return Object.hasOwn(mappings, kind);
}

export function classify(
  observed: ObservedSnapshot,
  resolved: ResolvedSnapshot,
  mappings: FacetMappings,
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
    .map((id) =>
      classifyElement(id as ElementInterpretation['elementId'], observedById.get(id), mappings),
    )
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
  mappings: FacetMappings,
): ElementInterpretation {
  if (observed === undefined) {
    return {
      elementId,
      facets: [],
      confidence: 'unknown',
      reason: 'no matching observed element for this resolved id',
    };
  }
  const mapping = mappings[observed.native.kind];
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
