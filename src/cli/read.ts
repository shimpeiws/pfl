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
import { SNAPSHOT_SCHEMA_VERSION } from '../snapshot/serialization.js';
import {
  listRuns,
  readInterpretationIfPresent,
  readLatestPointer,
  readObservedSnapshot,
  readResolvedSnapshot,
} from '../snapshot/store.js';
import { EXIT_CODES, PflError } from './exit-codes.js';

/**
 * The shared read path for `pfl report` / `list` / `show` / `graph` / `diff`
 * (design doc §15): resolve the requested snapshot (defaulting to `latest`),
 * load both layers, and load the stored Derived Interpretation. Since v1.0
 * `inspect` persists the interpretation, so a report reproduces and can name the
 * classifier that produced it; a snapshot captured before v1.0 carries none, and
 * the interpretation is recomputed for it (roadmap #84).
 *
 * `--snapshot` accepts either an observation id (`obs_…`) or a resolved id
 * (`res_…`). The literal `latest` (and an absent option) selects the most
 * recent run's resolved snapshot, so `--snapshot latest` is accepted anywhere
 * an id is, including as `diff`'s second operand (#89).
 */
export interface InterpretedRun {
  observed: ObservedSnapshot;
  resolved: ResolvedSnapshot;
  interpretation: Interpretation;
  /** Whether the interpretation came from the store or was recomputed (#84). */
  interpretationOrigin: 'stored' | 'recomputed';
  /** Store-level diagnostics encountered while resolving the snapshot. */
  diagnostics: Diagnostic[];
}

/** What the read commands report about the interpretation they used (#84). */
export interface InterpretationProvenance {
  classifierVersion: string;
  origin: 'stored' | 'recomputed';
}

export function interpretationProvenance(run: InterpretedRun): InterpretationProvenance {
  return {
    classifierVersion: run.interpretation.classifier.version,
    origin: run.interpretationOrigin,
  };
}

export async function loadInterpretation(
  cwd: string,
  requestedId: string | undefined,
  home: string = homedir(),
): Promise<InterpretedRun> {
  const project = await resolveProjectContext(cwd, {
    allowExternalGit: await hasAnyUserConsent(home),
  });
  const { resolvedId, interpretationId, diagnostics } = await resolveResolvedId(
    project.id,
    requestedId,
    home,
  );
  const resolved = await readResolvedSnapshot(project.id, resolvedId, home);
  const observed = await readObservedSnapshot(project.id, resolved.observedSnapshotId, home);

  if (interpretationId !== undefined) {
    // `null` means no interpretation is stored (a pre-v1.0 run): absence is
    // normal and the interpretation is recomputed. A stored interpretation this
    // binary cannot interpret is not absence — it fails closed like any other
    // direct read of an uninterpretable artifact (#82), so store corruption is
    // not masked by a fresh recomputation.
    const stored = await readInterpretationIfPresent(project.id, interpretationId, home);
    if (stored !== null && stored.resolvedSnapshotId === resolved.snapshotId) {
      return {
        observed,
        resolved,
        interpretation: stored,
        interpretationOrigin: 'stored',
        diagnostics,
      };
    }
    if (stored !== null) {
      // A stored interpretation for a different snapshot is recoverable: the
      // recomputation is correct for this snapshot, and the mismatch is
      // recorded rather than guessed at.
      diagnostics.push({
        severity: 'warning',
        code: 'interpretation-mismatch',
        message: `stored interpretation ${stored.interpretationId} does not match resolved snapshot ${resolved.snapshotId}; recomputed`,
        path: interpretationId,
      });
    }
  }

  return {
    observed,
    resolved,
    interpretation: recomputeInterpretation(observed, resolved),
    interpretationOrigin: 'recomputed',
    diagnostics,
  };
}

function recomputeInterpretation(
  observed: ObservedSnapshot,
  resolved: ResolvedSnapshot,
): Interpretation {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    interpretationId: generateInterpretationId(),
    resolvedSnapshotId: resolved.snapshotId,
    ...classify(observed, resolved),
    findings: deriveFindings(observed, resolved),
  };
}

async function resolveResolvedId(
  projectId: string,
  requestedId: string | undefined,
  home: string,
): Promise<{
  resolvedId: string;
  interpretationId: string | undefined;
  diagnostics: Diagnostic[];
}> {
  if (requestedId === undefined || requestedId === 'latest') {
    const pointer = await readLatestPointer(projectId, home);
    if (pointer === null) {
      throw new PflError(
        'no snapshots stored for this project; run `pfl inspect --runtime <id>` first',
        EXIT_CODES.CONFIG_ERROR,
      );
    }
    return {
      resolvedId: pointer.resolved,
      interpretationId: pointer.interpretation,
      diagnostics: [],
    };
  }

  const { runs, diagnostics } = await listRuns(projectId, home);
  const run = runs.find(
    (entry) => entry.resolvedId === requestedId || entry.observedId === requestedId,
  );
  if (run === undefined || run.resolvedId === null) {
    // A named id can be "unknown" because the artifact is present but
    // uninterpretable; carry the scan's diagnostics so the cause is not lost
    // (#82).
    throw new PflError(`unknown snapshot: ${requestedId}`, EXIT_CODES.CONFIG_ERROR, {
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    });
  }
  return {
    resolvedId: run.resolvedId,
    interpretationId: run.interpretationId ?? undefined,
    diagnostics,
  };
}
