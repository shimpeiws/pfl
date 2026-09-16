import { homedir } from 'node:os';
import { redactingLogger } from '../redact/output.js';
import type { Logger } from '../util/logger.js';
import { buildGraphModel } from './graph-model.js';
import { loadInterpretation } from './read.js';
import { detectTreeStyle, renderGraph } from './tree.js';

export interface GraphOptions {
  snapshot?: string;
  json?: boolean;
  /** Injected for tests; defaults to the current user's home. */
  home?: string;
}

/**
 * `pfl graph [--snapshot <id>]` (design doc §14, §27): render provenance and
 * resolution for the initial graph. It shows where each element came from, how
 * it was resolved, and what is effective now — never inferred edges, never
 * opaque contents. Advanced semantic dependency graphs are deferred.
 */
export async function runGraph(cwd: string, options: GraphOptions, logger: Logger): Promise<void> {
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
    out.info('graph', {
      observedSnapshotId: model.observedSnapshotId,
      resolvedSnapshotId: model.resolvedSnapshotId,
      nodes: model.nodes,
      edges: model.edges,
    });
    return;
  }

  for (const line of renderGraph(model, detectTreeStyle())) {
    out.info(line);
  }
}
