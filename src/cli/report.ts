import { homedir } from 'node:os';
import { HARNESS_FACETS } from '../core/facets.js';
import { getRuntimeName } from '../runtime/registry.js';
import { redactingLogger } from '../redact/output.js';
import type { Logger } from '../util/logger.js';
import { loadInterpretation } from './read.js';

export interface ReportOptions {
  snapshot?: string;
  json?: boolean;
  /** Injected for tests; defaults to the current user's home. */
  home?: string;
}

/**
 * `pfl report [--snapshot <id>]` (design doc §23, §26): render the harness
 * report. It interprets structure — counts, facets, descriptive findings — but
 * never says whether the harness is good or bad.
 */
export async function runReport(
  cwd: string,
  options: ReportOptions,
  logger: Logger,
): Promise<void> {
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
  const stats = interpretation.stats;
  const runtimeName = getRuntimeName(observed.runtime.id);

  if (options.json) {
    out.info('report', {
      runtime: observed.runtime.id,
      runtimeName,
      project: { id: observed.project.id, displayName: observed.project.displayName },
      observedSnapshotId: observed.snapshotId,
      resolvedSnapshotId: resolved.snapshotId,
      completeness: observed.completeness,
      confidence: resolved.resolution.confidence,
      stats,
      findings: interpretation.findings,
    });
    return;
  }

  out.info('Harness Report');
  out.info(`${runtimeName} · ${observed.project.displayName}`);
  out.info('');
  out.info(`Effective elements      ${stats.effective}`);
  out.info(`Shadowed                ${stats.shadowed}`);
  out.info(`Conditional             ${stats.conditional}`);
  out.info(`Opaque runtime layers   ${stats.opaque}`);
  out.info('');
  out.info('Semantic facets');
  for (const facet of HARNESS_FACETS) {
    out.info(`  ${capitalize(facet).padEnd(14, ' ')}${stats.byFacet[facet] ?? 0}`);
  }
  out.info('');
  out.info('Notable');
  if (interpretation.findings.length === 0) {
    out.info('  (none)');
  } else {
    for (const finding of interpretation.findings) {
      out.info(`  ${finding.message}`);
    }
  }

  if (resolved.resolution.confidence === 'unverified-runtime-version') {
    out.info('');
    out.warn(
      '⚠ the runtime version is outside the verified adapter range; interpretation is best-effort.',
    );
  }
  if (observed.completeness !== 'complete') {
    out.info('');
    out.warn(`⚠ scan completeness: ${observed.completeness}`);
  }
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
