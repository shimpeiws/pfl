import type { HarnessFacet } from '../core/facets.js';
import type { Interpretation } from '../core/interpretation.js';
import type { Inspectability, NativeOrigin, ObservedSnapshot } from '../core/observed.js';
import type { RelationType, ResolvedSnapshot, ResolvedStatus } from '../core/resolved.js';

/**
 * The graph model behind `pfl graph` (design doc §14, §27): one node per element
 * and one edge per relation. Only the relations a snapshot actually contains are
 * emitted — no speculative edges (the initial set is §14's).
 *
 * Nodes are keyed by the stable `ElementId`, and cover the union of observed and
 * resolved ids so an element a (possibly older) resolved snapshot omits is not
 * dropped. Paths are the readable label; ids remain the identity.
 */
export interface GraphNode {
  id: string;
  path: string;
  kind: string;
  origin: NativeOrigin;
  scope: string | null;
  status: ResolvedStatus;
  inspectability: Inspectability;
  facets: HarnessFacet[];
}

export interface GraphEdge {
  type: RelationType;
  from: string;
  to: string;
}

export interface GraphModel {
  observedSnapshotId: string;
  resolvedSnapshotId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Origin render order for the "where did this come from" section (design doc §27). */
export const ORIGIN_ORDER: readonly NativeOrigin[] = [
  'user',
  'project',
  'plugin',
  'managed',
  'builtin',
  'unknown',
];

/**
 * Node filters for `pfl graph` (#161): each repeatable filter ORs within
 * itself, filters combine with AND. The JSON document and the human tree share
 * the filtered model, so the `GraphModel` shape is unchanged — only `nodes` and
 * `edges` shrink. Edges whose endpoints were filtered out are dropped, so the
 * tree never references a node it did not print.
 */
export interface GraphFilter {
  origins?: ReadonlySet<NativeOrigin> | undefined;
  facets?: ReadonlySet<HarnessFacet> | undefined;
  kinds?: ReadonlySet<string> | undefined;
  statuses?: ReadonlySet<ResolvedStatus> | undefined;
}

export function filterGraphModel(model: GraphModel, filter: GraphFilter): GraphModel {
  const nodes = model.nodes.filter(
    (node) =>
      (filter.origins === undefined || filter.origins.has(node.origin)) &&
      (filter.facets === undefined || node.facets.some((facet) => filter.facets?.has(facet))) &&
      (filter.kinds === undefined || filter.kinds.has(node.kind)) &&
      (filter.statuses === undefined || filter.statuses.has(node.status)),
  );
  const present = new Set(nodes.map((node) => node.id));
  const edges = model.edges.filter((edge) => present.has(edge.from) && present.has(edge.to));
  return { ...model, nodes, edges };
}

export function buildGraphModel(
  observed: ObservedSnapshot,
  resolved: ResolvedSnapshot,
  interpretation: Interpretation,
): GraphModel {
  const observedById = new Map<string, ObservedSnapshot['elements'][number]>(
    observed.elements.map((element) => [element.id, element]),
  );
  const resolvedById = new Map<string, ResolvedSnapshot['elements'][number]>(
    resolved.elements.map((element) => [element.id, element]),
  );
  const facetsById = new Map<string, HarnessFacet[]>(
    interpretation.elements.map((element) => [element.elementId, element.facets]),
  );

  const ids = new Set<string>([
    ...observed.elements.map((element) => element.id),
    ...resolved.elements.map((element) => element.id),
  ]);

  const nodes: GraphNode[] = [...ids]
    .map((id) => {
      const observedElement = observedById.get(id);
      const resolvedElement = resolvedById.get(id);
      return {
        id,
        path: observedElement?.source.path ?? id,
        kind: observedElement?.native.kind ?? 'unknown',
        origin: observedElement?.native.origin ?? 'unknown',
        scope: observedElement?.native.scope ?? null,
        status: resolvedElement?.status ?? 'unknown',
        inspectability: observedElement?.inspectability ?? 'observable',
        facets: facetsById.get(id) ?? [],
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.id < b.id ? -1 : 1));

  const edges: GraphEdge[] = resolved.relations
    .map((relation) => ({ type: relation.type, from: relation.from, to: relation.to }))
    .sort((a, b) =>
      a.type !== b.type
        ? a.type < b.type
          ? -1
          : 1
        : a.from !== b.from
          ? a.from < b.from
            ? -1
            : 1
          : a.to < b.to
            ? -1
            : a.to > b.to
              ? 1
              : 0,
    );

  return {
    observedSnapshotId: observed.snapshotId,
    resolvedSnapshotId: resolved.snapshotId,
    nodes,
    edges,
  };
}
