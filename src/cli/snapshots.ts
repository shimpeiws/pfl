import { homedir } from 'node:os';
import { hasAnyUserConsent } from '../discovery/consent.js';
import { resolveProjectContext } from '../discovery/project-identity.js';
import { redactingLogger } from '../redact/output.js';
import { resolveStoredProjectId } from '../snapshot/project-index.js';
import { listRuns, type StoredRunSummary } from '../snapshot/store.js';
import type { Logger } from '../util/logger.js';
import { type CommandOutcome } from './document.js';

export interface SnapshotsOptions {
  json?: boolean;
  /** Injected for tests; defaults to the current user's home. */
  home?: string;
}

export interface SnapshotsData {
  project: string;
  runs: StoredRunSummary[];
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
): Promise<CommandOutcome<SnapshotsData>> {
  const home = options.home ?? homedir();
  const out = redactingLogger(logger, options.json ? 'export' : 'display', { home });
  const context = await resolveProjectContext(cwd, {
    allowExternalGit: await hasAnyUserConsent(home),
  });
  const stored = await resolveStoredProjectId(context, home);
  const { runs, diagnostics } = await listRuns(stored.id, home);
  diagnostics.unshift(...stored.diagnostics);

  for (const diagnostic of diagnostics) {
    out.warn(diagnostic.message, { code: diagnostic.code, path: diagnostic.path });
  }

  // No single harness is observed; the envelope reports `unknown` completeness.
  const outcome = {
    data: { project: stored.id, runs },
    diagnostics,
    completeness: 'unknown' as const,
  };

  if (options.json) return outcome;

  if (runs.length === 0) {
    out.info(`No snapshots stored for ${context.displayName}.`);
    return outcome;
  }

  out.info(`${runs.length} snapshot(s) for ${context.displayName}:`);
  for (const run of runs) {
    out.info(formatRun(run));
  }
  return outcome;
}

function formatRun(run: StoredRunSummary): string {
  const version = run.runtime.version ?? 'unknown';
  const resolved = run.resolvedId ?? 'unresolved';
  return `${run.observedId}  ${resolved}  ${run.capturedAt}  ${run.runtime.id}@${version}  ${run.completeness}`;
}
