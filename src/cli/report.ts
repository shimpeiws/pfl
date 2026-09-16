import { homedir } from 'node:os';
import { HARNESS_FACETS } from '../core/facets.js';
import { getRuntimeName } from '../runtime/registry.js';
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
  const { observed, resolved, interpretation, diagnostics } = await loadInterpretation(
    cwd,
    options.snapshot,
    home,
  );
  for (const diagnostic of diagnostics) {
    logger.warn(diagnostic.message, { code: diagnostic.code, path: diagnostic.path ?? undefined });
  }
  const stats = interpretation.stats;
  const runtimeName = getRuntimeName(observed.runtime.id);

  if (options.json) {
    logger.info('report', {
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

  logger.info('Harness Report');
  logger.info(`${runtimeName} · ${observed.project.displayName}`);
  logger.info('');
  logger.info(`Effective elements      ${stats.effective}`);
  logger.info(`Shadowed                ${stats.shadowed}`);
  logger.info(`Conditional             ${stats.conditional}`);
  logger.info(`Opaque runtime layers   ${stats.opaque}`);
  logger.info('');
  logger.info('Semantic facets');
  for (const facet of HARNESS_FACETS) {
    logger.info(`  ${capitalize(facet).padEnd(14, ' ')}${stats.byFacet[facet] ?? 0}`);
  }
  logger.info('');
  logger.info('Notable');
  if (interpretation.findings.length === 0) {
    logger.info('  (none)');
  } else {
    for (const finding of interpretation.findings) {
      logger.info(`  ${finding.message}`);
    }
  }

  if (resolved.resolution.confidence === 'unverified-runtime-version') {
    logger.info('');
    logger.warn(
      '⚠ the runtime version is outside the verified adapter range; interpretation is best-effort.',
    );
  }
  if (observed.completeness !== 'complete') {
    logger.info('');
    logger.warn(`⚠ scan completeness: ${observed.completeness}`);
  }
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
