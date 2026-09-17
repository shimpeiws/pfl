import { homedir } from 'node:os';
import { redactPath, redactingLogger } from '../redact/output.js';
import type { Logger } from '../util/logger.js';
import { type CommandOutcome } from './document.js';
import { buildGraphModel, type GraphModel } from './graph-model.js';
import { loadInterpretation } from './read.js';
import { detectTreeStyle, renderGraph } from './tree.js';

export interface GraphOptions {
  snapshot?: string;
  json?: boolean;
  /** Injected for tests; defaults to the current user's home. */
  home?: string;
}

export type GraphData = GraphModel;

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
  const { observed, resolved, interpretation, diagnostics } = await loadInterpretation(
    cwd,
    options.snapshot,
    home,
  );
  for (const diagnostic of diagnostics) {
    out.warn(diagnostic.message, { code: diagnostic.code, path: diagnostic.path ?? undefined });
  }

  const model = buildGraphModel(observed, resolved, interpretation);
  if (options.json) {
    // Nodes are ordered by id, as the document contract states; the human tree
    // keeps its path order. Paths are re-redacted at the export boundary, so a
    // stored artifact that predates redaction cannot leak a raw path.
    const nodes = [...model.nodes]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((node) => ({ ...node, path: redactPath(node.path, { home }) }));
    return {
      data: { ...model, nodes },
      diagnostics,
      completeness: observed.completeness,
    };
  }

  for (const line of renderGraph(model, detectTreeStyle())) {
    out.info(line);
  }
  return { data: model, diagnostics, completeness: observed.completeness };
}
