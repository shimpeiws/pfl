import { access, rm, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Diagnostic } from '../core/diagnostics.js';
import { hasAnyUserConsent } from '../discovery/consent.js';
import { resolveProjectContext } from '../discovery/project-identity.js';
import { redactingLogger } from '../redact/output.js';
import { readProjectIndex, resolveStoredProjectId } from '../snapshot/project-index.js';
import {
  artifactFilePath,
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
  /** Display path, home-relative so it carries no account name. */
  path: string;
  reason: string;
}

export interface GcData {
  dryRun: boolean;
  keep: number;
  retained: GcRunRef[];
  reclaimed: GcRunRef[];
  /** Orphaned histories (every claiming root is gone); deleted with `--prune-orphans`. */
  orphans: GcOrphanRef[];
  /** Whether this run actually deleted the orphans. */
  orphansReclaimed: boolean;
  /** Store directories the index does not reference; reported, never auto-deleted. */
  unreferenced: GcOrphanRef[];
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
  // A collection command does not claim or adopt histories: resolve the id
  // without writing the index.
  const stored = await resolveStoredProjectId(context, home, { write: false });
  const diagnostics: Diagnostic[] = [...stored.diagnostics];

  const { runs, diagnostics: runDiagnostics } = await listRuns(stored.id, home);
  diagnostics.push(...runDiagnostics);
  const latest = await readLatestPointer(stored.id, home);

  const { retained, reclaimed } = planRetention(runs, latest?.observed, keep);

  const reclaimedRuns: GcRunRef[] = [];
  if (!dryRun) {
    for (const run of reclaimed) {
      const failures = await reclaimRun(stored.id, run, home);
      diagnostics.push(...failures);
      // Report a run as reclaimed only when every artifact is gone; a partial
      // deletion stays out of the document and in the diagnostics.
      if (failures.length === 0) reclaimedRuns.push(toRunRef(run));
    }
  }

  const { orphans, unreferenced } = await findOrphans(stored.id, home);
  const prunedOrphans: GcOrphanRef[] = [];
  if (pruneOrphans && !dryRun) {
    for (const orphan of orphans) {
      try {
        await rm(projectDir(orphan.id, home), { recursive: true, force: true });
        prunedOrphans.push(orphan);
      } catch (error) {
        diagnostics.push({
          severity: 'warning',
          code: 'reclaim-failed',
          message: `could not reclaim ${orphan.path}: ${error instanceof Error ? error.message : String(error)}`,
          path: orphan.path,
        });
      }
    }
  }
  const orphansReclaimed = prunedOrphans.length > 0;
  if (!orphansReclaimed && orphans.length > 0 && !pruneOrphans) {
    diagnostics.push({
      severity: 'info',
      code: 'orphans-not-reclaimed',
      message: `${orphans.length} orphaned project histor(y/ies) exist; rerun with --prune-orphans to reclaim them`,
    });
  }

  for (const diagnostic of diagnostics) {
    out.warn(diagnostic.message, { code: diagnostic.code, path: diagnostic.path ?? undefined });
  }

  const data: GcData = {
    dryRun,
    keep,
    retained: retained.map(toRunRef),
    reclaimed: dryRun ? reclaimed.map(toRunRef) : reclaimedRuns,
    orphans,
    orphansReclaimed,
    unreferenced,
  };
  const outcome = { data, diagnostics, completeness: 'unknown' as const };

  if (options.json) return outcome;

  const verb = dryRun ? 'Would reclaim' : 'Reclaimed';
  out.info(
    `${dryRun ? 'Dry run for' : 'Garbage collection for'} ${context.displayName}: keep ${keep}, retain ${data.retained.length}, ${verb.toLowerCase()} ${data.reclaimed.length} run(s).`,
  );
  for (const run of data.reclaimed) {
    out.info(`  ${verb} ${run.observedId}${run.resolvedId !== null ? ` → ${run.resolvedId}` : ''}`);
  }
  if (orphans.length > 0) {
    out.info(
      orphansReclaimed
        ? `Reclaimed ${orphans.length} orphaned histor(y/ies).`
        : dryRun
          ? `Would reclaim ${orphans.length} orphaned histor(y/ies) (--prune-orphans).`
          : `${orphans.length} orphaned histor(y/ies) (use --prune-orphans to reclaim).`,
    );
    for (const orphan of orphans) out.info(`  ${orphan.id}  ${orphan.path}  (${orphan.reason})`);
  }
  for (const entry of unreferenced) {
    out.info(`  unreferenced: ${entry.id}  ${entry.path}  (${entry.reason})`);
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
 * The newest `keep` runs are retained, **and** the run named by `latest` is
 * always retained. When `latest` is older than the newest `keep`, that is
 * `keep + 1` runs; the run the pointer names is never reclaimed. Runs are newest
 * first, so the tail is the oldest.
 */
export function planRetention(
  runs: readonly StoredRunSummary[],
  latestObservedId: string | undefined,
  keep: number,
): { retained: StoredRunSummary[]; reclaimed: StoredRunSummary[] } {
  const retainedIds = new Set(runs.slice(0, keep).map((run) => run.observedId));
  if (latestObservedId !== undefined) {
    retainedIds.add(latestObservedId);
  }
  return {
    retained: runs.filter((run) => retainedIds.has(run.observedId)),
    reclaimed: runs.filter((run) => !retainedIds.has(run.observedId)),
  };
}

/**
 * Deletes one run's artifacts dependents-first, so a failure never leaves a
 * resolved snapshot whose observed base is gone. Returns a diagnostic per
 * artifact that could not be removed; the run is reported as reclaimed only
 * when this is empty.
 */
async function reclaimRun(
  projectId: string,
  run: StoredRunSummary,
  home: string,
): Promise<Diagnostic[]> {
  // Ids come from parsed artifacts; validate each before it becomes a path
  // segment so a crafted id cannot make gc delete outside the store.
  const targets: string[] = [];
  if (run.resolvedId !== null) {
    // The interpretation is keyed by the resolved id and belongs to the run even
    // when its payload could not be parsed (then `interpretationId` is null).
    targets.push(artifactFilePath(interpretationsDir(projectId, home), run.resolvedId));
    targets.push(artifactFilePath(snapshotsDir(projectId, home), run.resolvedId));
  }
  targets.push(artifactFilePath(observationsDir(projectId, home), run.observedId));

  const failures: Diagnostic[] = [];
  for (const target of targets) {
    const failure = await removeArtifact(target);
    if (failure !== undefined) {
      failures.push(failure);
      break;
    }
  }
  return failures;
}

/** Removes one artifact; `undefined` on success (including already absent). */
async function removeArtifact(target: string): Promise<Diagnostic | undefined> {
  try {
    await unlink(target);
    return undefined;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined;
    return {
      severity: 'warning',
      code: 'reclaim-failed',
      message: `could not reclaim ${target}: ${error instanceof Error ? error.message : String(error)}`,
      path: target,
    };
  }
}

/**
 * Orphans are project directories the index references whose every root is gone
 * on disk; only those are deletable. A directory the index does not reference
 * has an unknown root, so it is reported as unreferenced and never deleted — a
 * history that has not been adopted yet must not be destroyed by a command run
 * for a different project. The current project is neither.
 */
async function findOrphans(
  currentId: string,
  home: string,
): Promise<{ orphans: GcOrphanRef[]; unreferenced: GcOrphanRef[] }> {
  const index = await readProjectIndex(home);
  const rootsById = new Map<string, string[]>();
  for (const [root, id] of Object.entries(index.projects)) {
    const roots = rootsById.get(id) ?? [];
    roots.push(root);
    rootsById.set(id, roots);
  }

  const orphans: GcOrphanRef[] = [];
  const unreferenced: GcOrphanRef[] = [];
  for (const id of await listProjectIds(home)) {
    if (id === currentId) continue;
    const roots = rootsById.get(id);
    if (roots === undefined) {
      unreferenced.push({
        id,
        path: displayProjectDir(id),
        reason: 'not referenced by the project index',
      });
      continue;
    }
    // Only a root that is definitely gone makes an orphan. An unreadable root
    // (a permission error) is `unknown`, and unknown is treated as present, so a
    // transient error cannot turn a live history into a deletable one.
    const states = await Promise.all(roots.map(rootState));
    const active = states.some((state) => state !== 'gone');
    if (!active) {
      orphans.push({
        id,
        path: displayProjectDir(id),
        reason: 'its project root no longer exists',
      });
    }
  }
  return { orphans, unreferenced };
}

function displayProjectDir(id: string): string {
  return join('~/.pfl', 'projects', id);
}

/** Whether a root is present, definitely absent, or unreadable (treated as present). */
async function rootState(path: string): Promise<'present' | 'gone' | 'unknown'> {
  try {
    await access(path);
    return 'present';
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'gone' : 'unknown';
  }
}

function toRunRef(run: StoredRunSummary): GcRunRef {
  return {
    observedId: run.observedId,
    resolvedId: run.resolvedId,
    interpretationId: run.interpretationId,
  };
}
