import { homedir } from 'node:os';
import { classify } from '../classify/classifier.js';
import { deriveFindings } from '../classify/findings.js';
import type { Diagnostic } from '../core/diagnostics.js';
import { generateInterpretationId } from '../core/ids.js';
import type { Interpretation } from '../core/interpretation.js';
import type { ObservedSnapshot } from '../core/observed.js';
import type { ResolvedSnapshot } from '../core/resolved.js';
import { hasAnyUserConsent } from '../discovery/consent.js';
import { resolveProjectContext } from '../discovery/project-identity.js';
import {
  listRuns,
  readLatestPointer,
  readObservedSnapshot,
  readResolvedSnapshot,
} from '../snapshot/store.js';
import { EXIT_CODES, PflError } from './exit-codes.js';

/**
 * The shared read path for `pfl report` / `list` / `show` (design doc §15):
 * resolve the requested snapshot (defaulting to `latest`), load both layers,
 * and recompute the Derived Interpretation. Interpretations are never persisted,
 * so improved classification logic always applies to existing snapshots.
 *
 * `--snapshot` accepts either an observation id (`obs_…`) or a resolved id
 * (`res_…`); `latest` points at a resolved snapshot.
 */
export interface InterpretedRun {
  observed: ObservedSnapshot;
  resolved: ResolvedSnapshot;
  interpretation: Interpretation;
  /** Store-level diagnostics encountered while resolving the snapshot. */
  diagnostics: Diagnostic[];
}

export async function loadInterpretation(
  cwd: string,
  requestedId: string | undefined,
  home: string = homedir(),
): Promise<InterpretedRun> {
  const project = await resolveProjectContext(cwd, {
    allowExternalGit: await hasAnyUserConsent(home),
  });
  const { resolvedId, diagnostics } = await resolveResolvedId(project.id, requestedId, home);
  const resolved = await readResolvedSnapshot(project.id, resolvedId, home);
  const observed = await readObservedSnapshot(project.id, resolved.observedSnapshotId, home);

  const interpretation: Interpretation = {
    interpretationId: generateInterpretationId(),
    resolvedSnapshotId: resolved.snapshotId,
    ...classify(observed, resolved),
    findings: deriveFindings(observed, resolved),
  };
  return { observed, resolved, interpretation, diagnostics };
}

async function resolveResolvedId(
  projectId: string,
  requestedId: string | undefined,
  home: string,
): Promise<{ resolvedId: string; diagnostics: Diagnostic[] }> {
  if (requestedId === undefined) {
    const pointer = await readLatestPointer(projectId, home);
    if (pointer === null) {
      throw new PflError(
        'no snapshots stored for this project; run `pfl inspect --runtime <id>` first',
        EXIT_CODES.CONFIG_ERROR,
      );
    }
    return { resolvedId: pointer.resolved, diagnostics: [] };
  }

  const { runs, diagnostics } = await listRuns(projectId, home);
  const run = runs.find(
    (entry) => entry.resolvedId === requestedId || entry.observedId === requestedId,
  );
  if (run === undefined || run.resolvedId === null) {
    throw new PflError(`unknown snapshot: ${requestedId}`, EXIT_CODES.CONFIG_ERROR);
  }
  return { resolvedId: run.resolvedId, diagnostics };
}
