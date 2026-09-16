import { homedir } from 'node:os';
import { resolveProjectContext } from '../discovery/project-identity.js';
import { redactingLogger } from '../redact/output.js';
import { listRuns, type StoredRunSummary } from '../snapshot/store.js';
import type { Logger } from '../util/logger.js';

export interface SnapshotsOptions {
  json?: boolean;
  /** Injected for tests; defaults to the current user's home. */
  home?: string;
}

/**
 * `pfl snapshots` (design doc §23): list stored snapshots for the current
 * project, newest first. A "snapshot" here is one run: an observation event and
 * the resolved snapshot derived from it.
 */
export async function runSnapshots(
  cwd: string,
  options: SnapshotsOptions,
  logger: Logger,
): Promise<void> {
  const home = options.home ?? homedir();
  const out = redactingLogger(logger, options.json ? 'export' : 'display', { home });
  const project = await resolveProjectContext(cwd);
  const { runs, diagnostics } = await listRuns(project.id, home);

  for (const diagnostic of diagnostics) {
    out.warn(diagnostic.message, { code: diagnostic.code, path: diagnostic.path });
  }

  if (options.json) {
    out.info('snapshots', { project: project.id, runs });
    return;
  }

  if (runs.length === 0) {
    out.info(`No snapshots stored for ${project.displayName}.`);
    return;
  }

  out.info(`${runs.length} snapshot(s) for ${project.displayName}:`);
  for (const run of runs) {
    out.info(formatRun(run));
  }
}

function formatRun(run: StoredRunSummary): string {
  const version = run.runtime.version ?? 'unknown';
  const resolved = run.resolvedId ?? 'unresolved';
  return `${run.observedId}  ${resolved}  ${run.capturedAt}  ${run.runtime.id}@${version}  ${run.completeness}`;
}
