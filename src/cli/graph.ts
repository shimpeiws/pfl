import { homedir } from 'node:os';
import { redactPath, redactingLogger } from '../redact/output.js';
import type { Logger } from '../util/logger.js';
import { type CommandOutcome } from './document.js';
import { validateFacets, validateKinds, validateOrigins, validateStatuses } from './filters.js';
import { buildGraphModel, filterGraphModel, type GraphModel } from './graph-model.js';
import {
  interpretationProvenance,
  loadInterpretation,
  type InterpretationProvenance,
} from './read.js';
import { detectTreeStyle, renderGraph } from './tree.js';

export interface GraphOptions {
  snapshot?: string;
  /** Scope `latest` to a runtime's newest run (#180). */
  runtime?: string;
  /** Repeatable filters (each ORs within itself, filters AND) (#161). */
  origin?: readonly string[];
  facet?: readonly string[];
  kind?: readonly string[];
  status?: readonly string[];
  json?: boolean;
  /** Injected for tests; defaults to the current user's home. */
  home?: string;
}

export type GraphData = GraphModel & {
  /** The runtime the answered snapshot belongs to (#180). */
  runtime: string;
  interpretation: InterpretationProvenance;
};

/**
 * `pfl graph [--snapshot <id>]` (design doc §14, §27): render provenance and
 * resolution for the initial graph. It shows where each element came from, how
 * it was resolved, and what is effective now — never inferred edges, never
 * opaque contents. Advanced semantic dependency graphs are deferred.
 */
export async function runGraph(
  cwd: string,
  options: GraphOptions,
  logger: Logger,
): Promise<CommandOutcome<GraphData>> {
  const home = options.home ?? homedir();
  const out = redactingLogger(logger, options.json ? 'export' : 'display', { home });
  const run = await loadInterpretation(cwd, options.snapshot, home, options.runtime);
  const { observed, resolved, interpretation, diagnostics } = run;
  for (const diagnostic of diagnostics) {
    out.warn(diagnostic.message, { code: diagnostic.code, path: diagnostic.path ?? undefined });
  }

  const filter = {
    origins: validateOrigins(options.origin),
    facets: validateFacets(options.facet),
    kinds: validateKinds(options.kind),
    statuses: validateStatuses(options.status),
  };
  const model = filterGraphModel(buildGraphModel(observed, resolved, interpretation), filter);
  const provenance = interpretationProvenance(run);
  if (options.json) {
    // Nodes are ordered by id, as the document contract states; the human tree
    // keeps its path order. Paths are re-redacted at the export boundary, so a
    // stored artifact that predates redaction cannot leak a raw path.
    const nodes = [...model.nodes]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((node) => ({ ...node, path: redactPath(node.path, { home }) }));
    return {
      data: { ...model, nodes, runtime: observed.runtime.id, interpretation: provenance },
      diagnostics,
      completeness: observed.completeness,
    };
  }

  // The runtime stays prominent so an agent can assert which snapshot answered.
  out.info(`Runtime: ${observed.runtime.id} (${resolved.snapshotId})`);
  out.info('');
  for (const line of renderGraph(model, detectTreeStyle())) {
    out.info(line);
  }
  return {
    data: { ...model, runtime: observed.runtime.id, interpretation: provenance },
    diagnostics,
    completeness: observed.completeness,
  };
}
