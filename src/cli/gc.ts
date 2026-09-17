import { access, rm, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Diagnostic } from '../core/diagnostics.js';
import { hasAnyUserConsent } from '../discovery/consent.js';
import { resolveProjectContext } from '../discovery/project-identity.js';
import { redactingLogger } from '../redact/output.js';
import { readProjectIndex, resolveStoredProjectId } from '../snapshot/project-index.js';
import {
  interpretationsDir,
  listProjectIds,
  listRuns,
  observationsDir,
  projectDir,
  readLatestPointer,
  snapshotsDir,
  type StoredRunSummary,
} from '../snapshot/store.js';
import type { Logger } from '../util/logger.js';
import { type CommandOutcome } from './document.js';
import { EXIT_CODES, PflError } from './exit-codes.js';

/** Retention is by run count per project, not by age (roadmap #87). */
export const DEFAULT_RETENTION_RUNS = 20;

export interface GcOptions {
  dryRun?: boolean;
  keep?: number;
  pruneOrphans?: boolean;
  json?: boolean;
  /** Injected for tests; defaults to the current user's home. */
  home?: string;
}

/** One run's ids, so a consumer can see exactly what a run reclaims. */
export interface GcRunRef {
  observedId: string;
  resolvedId: string | null;
  interpretationId: string | null;
}

export interface GcOrphanRef {
  id: string;
  path: string;
  reason: string;
}

export interface GcData {
  dryRun: boolean;
  keep: number;
  retained: GcRunRef[];
  reclaimed: GcRunRef[];
  /** Orphaned histories, listed always; deleted only with `--prune-orphans`. */
  orphans: GcOrphanRef[];
}

/**
 * `pfl gc` (roadmap #87, design doc §29, §33): reclaim old runs and orphaned
 * histories so `~/.pfl/` stops growing without bound. Collection is explicit —
 * never a side effect of `inspect` — because deleting a user's records silently
 * is out of character for a read-only tool.
 *
 * A run is reclaimed as a whole: its observed snapshot, resolved snapshot, and
 * interpretation together, so collection cannot leave a resolved snapshot whose
 * interpretation is gone, or an interpretation with nothing to interpret. The
 * run named by `latest` is always retained.
 */
export async function runGc(
  cwd: string,
  options: GcOptions,
  logger: Logger,
): Promise<CommandOutcome<GcData>> {
  const home = options.home ?? homedir();
  const out = redactingLogger(logger, options.json ? 'export' : 'display', { home });
  const dryRun = options.dryRun === true;
  const pruneOrphans = options.pruneOrphans === true;
  const keep = normalizeKeep(options.keep);

  const context = await resolveProjectContext(cwd, {
    allowExternalGit: await hasAnyUserConsent(home),
  });
  const stored = await resolveStoredProjectId(context, home);
  const diagnostics: Diagnostic[] = [...stored.diagnostics];

  const { runs, diagnostics: runDiagnostics } = await listRuns(stored.id, home);
  diagnostics.push(...runDiagnostics);
  const latest = await readLatestPointer(stored.id, home);

  const { retained, reclaimed } = planRetention(runs, latest?.observed, keep);

  const reclaimedRuns: GcRunRef[] = [];
  if (!dryRun) {
    for (const run of reclaimed) {
      await reclaimRun(stored.id, run, home);
      reclaimedRuns.push(toRunRef(run));
    }
  }

  const orphans = await findOrphans(stored.id, home);
  if (pruneOrphans && !dryRun) {
    for (const orphan of orphans) {
      await rm(orphan.path, { recursive: true, force: true });
    }
  } else if (orphans.length > 0 && !pruneOrphans) {
    diagnostics.push({
      severity: 'info',
      code: 'orphans-not-reclaimed',
      message: `${orphans.length} orphaned project histor(y/ies) exist; rerun with --prune-orphans to reclaim them`,
    });
  }

  const data: GcData = {
    dryRun,
    keep,
    retained: retained.map(toRunRef),
    reclaimed: dryRun ? reclaimed.map(toRunRef) : reclaimedRuns,
    orphans,
  };
  const outcome = { data, diagnostics, completeness: 'unknown' as const };

  if (options.json) return outcome;

  const prefix = dryRun ? 'Would reclaim' : 'Reclaimed';
  out.info(
    `${dryRun ? 'Dry run for' : 'Garbage collection for'} ${context.displayName}: keep ${keep}, retain ${data.retained.length}, ${prefix.toLowerCase()} ${data.reclaimed.length} run(s).`,
  );
  for (const run of data.reclaimed) {
    out.info(
      `  ${prefix} ${run.observedId}${run.resolvedId !== null ? ` → ${run.resolvedId}` : ''}`,
    );
  }
  if (orphans.length > 0) {
    out.info(
      pruneOrphans && !dryRun
        ? `Reclaimed ${orphans.length} orphaned histor(y/ies).`
        : `${orphans.length} orphaned histor(y/ies) (use --prune-orphans to reclaim).`,
    );
    for (const orphan of orphans) {
      out.info(`  ${orphan.id}  ${orphan.path}  (${orphan.reason})`);
    }
  }
  return outcome;
}

function normalizeKeep(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RETENTION_RUNS;
  if (!Number.isInteger(value) || value < 0) {
    throw new PflError('--keep must be a non-negative integer', EXIT_CODES.CONFIG_ERROR);
  }
  // `latest` is always retained, so a keep below one still keeps the latest run.
  return Math.max(1, value);
}

/**
 * The newest `keep` runs are retained, and the run named by `latest` is always
 * among them. Runs are newest first, so the tail is the oldest.
 */
export function planRetention(
  runs: readonly StoredRunSummary[],
  latestObservedId: string | undefined,
  keep: number,
): { retained: StoredRunSummary[]; reclaimed: StoredRunSummary[] } {
  const retained = runs.slice(0, keep);
  const reclaimed = runs.slice(keep);
  if (
    latestObservedId !== undefined &&
    !retained.some((run) => run.observedId === latestObservedId)
  ) {
    const index = reclaimed.findIndex((run) => run.observedId === latestObservedId);
    const latestRun = index >= 0 ? reclaimed.splice(index, 1)[0] : undefined;
    const displaced = retained.pop();
    if (latestRun !== undefined) retained.push(latestRun);
    if (displaced !== undefined) reclaimed.unshift(displaced);
  }
  return { retained, reclaimed };
}

async function reclaimRun(projectId: string, run: StoredRunSummary, home: string): Promise<void> {
  const targets = [join(observationsDir(projectId, home), `${run.observedId}.json`)];
  if (run.resolvedId !== null) {
    targets.push(join(snapshotsDir(projectId, home), `${run.resolvedId}.json`));
    if (run.interpretationId !== null) {
      targets.push(join(interpretationsDir(projectId, home), `${run.resolvedId}.json`));
    }
  }
  for (const target of targets) {
    await unlink(target).catch((error: unknown) => {
      if ((error as { code?: string }).code === 'ENOENT') return;
      throw new PflError(
        `could not reclaim ${target}: ${error instanceof Error ? error.message : String(error)}`,
        EXIT_CODES.SNAPSHOT_STORE_FAILED,
      );
    });
  }
}

/**
 * A project directory is orphaned when the index does not reference it, or when
 * every root that claims it no longer exists on disk. The current project is
 * never orphaned. Orphans are listed; only `--prune-orphans` deletes them.
 */
async function findOrphans(currentId: string, home: string): Promise<GcOrphanRef[]> {
  const index = await readProjectIndex(home);
  const rootsById = new Map<string, string[]>();
  for (const [root, id] of Object.entries(index.projects)) {
    const roots = rootsById.get(id) ?? [];
    roots.push(root);
    rootsById.set(id, roots);
  }

  const orphans: GcOrphanRef[] = [];
  for (const id of await listProjectIds(home)) {
    if (id === currentId) continue;
    const roots = rootsById.get(id);
    if (roots === undefined) {
      orphans.push({
        id,
        path: projectDir(id, home),
        reason: 'not referenced by the project index',
      });
      continue;
    }
    const exists = (await Promise.all(roots.map(pathExists))).some(Boolean);
    if (!exists) {
      orphans.push({
        id,
        path: projectDir(id, home),
        reason: 'its project root no longer exists',
      });
    }
  }
  return orphans;
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function toRunRef(run: StoredRunSummary): GcRunRef {
  return {
    observedId: run.observedId,
    resolvedId: run.resolvedId,
    interpretationId: run.interpretationId,
  };
}
