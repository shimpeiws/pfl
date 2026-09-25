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
import { getClassifierContribution } from '../runtime/registry.js';
import { resolveStoredProjectId } from '../snapshot/project-index.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../snapshot/serialization.js';
import {
  listRuns,
  readInterpretationForResolved,
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
  /**
   * The canonical (unredacted) project root resolved from cwd.
   * D3: bundle needs this for evidence resolution, since observed.project.root
   * is redacted at persistence time.
   */
  canonicalProjectRoot: string;
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
  runtime?: string,
): Promise<InterpretedRun> {
  const context = await resolveProjectContext(cwd, {
    allowExternalGit: await hasAnyUserConsent(home),
  });
  // A read does not mutate the store; it computes the same id an `inspect`
  // would persist (roadmap #86).
  const storedProject = await resolveStoredProjectId(context, home, { write: false });
  const { resolvedId, diagnostics } = await resolveResolvedId(
    storedProject.id,
    requestedId,
    home,
    runtime,
  );
  diagnostics.unshift(...storedProject.diagnostics);
  const resolved = await readResolvedSnapshot(storedProject.id, resolvedId, home);
  const observed = await readObservedSnapshot(storedProject.id, resolved.observedSnapshotId, home);

  // `null` means no interpretation is stored (a pre-v1.0 run): absence is
  // normal and the interpretation is recomputed. A stored interpretation this
  // binary cannot interpret is not absence — it fails closed like any other
  // direct read of an uninterpretable artifact (#82), so store corruption is
  // not masked by a fresh recomputation.
  const stored = await readInterpretationForResolved(storedProject.id, resolved.snapshotId, home);
  if (stored !== null) {
    return {
      observed,
      resolved,
      interpretation: stored,
      interpretationOrigin: 'stored',
      diagnostics,
      canonicalProjectRoot: context.root,
    };
  }

  return {
    observed,
    resolved,
    interpretation: recomputeInterpretation(observed, resolved),
    interpretationOrigin: 'recomputed',
    diagnostics,
    canonicalProjectRoot: context.root,
  };
}

function recomputeInterpretation(
  observed: ObservedSnapshot,
  resolved: ResolvedSnapshot,
): Interpretation {
  const { mappings, findingKinds } = getClassifierContribution();
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    interpretationId: generateInterpretationId(),
    resolvedSnapshotId: resolved.snapshotId,
    ...classify(observed, resolved, mappings),
    findings: deriveFindings(observed, resolved, findingKinds),
  };
}

async function resolveResolvedId(
  projectId: string,
  requestedId: string | undefined,
  home: string,
  runtime?: string,
): Promise<{ resolvedId: string; diagnostics: Diagnostic[] }> {
  if (requestedId === undefined || requestedId === 'latest') {
    if (runtime !== undefined) {
      // The `latest` pointer names whichever runtime was inspected last, so a
      // runtime-scoped read scans the run list for the newest matching
      // resolved run instead (#180).
      const { runs, diagnostics } = await listRuns(projectId, home);
      const context = diagnostics.length > 0 ? { diagnostics } : {};
      throwOnStoreFailure(diagnostics);
      const scoped = runs.filter((entry) => entry.runtime.id === runtime);
      const first = scoped.at(0);
      if (first === undefined) {
        throw new PflError(
          `no snapshots stored for runtime ${runtime}; run \`pfl inspect --runtime ${runtime}\` first`,
          EXIT_CODES.CONFIG_ERROR,
          context,
        );
      }
      // `runs` is newest first, but `capturedAt` has millisecond precision and
      // a tie keeps directory order, which does not track inspection order.
      // The `latest` pointer names the run that finished last, so it breaks a
      // tie among matching-runtime runs at the newest timestamp.
      let newest = first;
      const tied = scoped.filter((entry) => entry.capturedAt === first.capturedAt);
      if (tied.length > 1) {
        const pointer = await readLatestPointer(projectId, home);
        const pointed = tied.find((entry) => entry.observedId === pointer?.observed);
        if (pointed !== undefined) newest = pointed;
      }
      if (newest.resolvedId === null) {
        // The newest matching run is unusable; answering with an older one
        // would silently serve a stale harness as `latest`.
        throw new PflError(
          `could not read a resolved snapshot for the newest ${runtime} run`,
          EXIT_CODES.CONFIG_ERROR,
          context,
        );
      }
      return { resolvedId: newest.resolvedId, diagnostics };
    }
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
  throwOnStoreFailure(diagnostics);
  const run = runs.find(
    (entry) => entry.resolvedId === requestedId || entry.observedId === requestedId,
  );
  // A named id can fail because the artifact is present but uninterpretable.
  // Say so, naming the cause, rather than calling a readable-on-disk snapshot
  // "unknown"; the scan's diagnostics carry it either way (#82).
  const context = diagnostics.length > 0 ? { diagnostics } : {};
  if (run === undefined) {
    // Diagnostic paths are store-relative and prefixed by artifact class, so
    // the cause is attributable to the requested snapshot and not confused with
    // an interpretation artifact that happens to share its id.
    const unreadable = diagnostics.find(
      (entry) =>
        entry.path === `snapshots/${requestedId}.json` ||
        entry.path === `observations/${requestedId}.json`,
    );
    if (unreadable !== undefined) {
      throw new PflError(
        `could not read snapshot ${requestedId}: ${unreadable.message}`,
        EXIT_CODES.CONFIG_ERROR,
        context,
      );
    }
    throw new PflError(`unknown snapshot: ${requestedId}`, EXIT_CODES.CONFIG_ERROR, context);
  }
  if (runtime !== undefined && run.runtime.id !== runtime) {
    throw new PflError(
      `snapshot ${requestedId} is a ${run.runtime.id} snapshot, not ${runtime}`,
      EXIT_CODES.CONFIG_ERROR,
      context,
    );
  }
  if (run.resolvedId === null) {
    // A resolved snapshot that failed to read cannot be attributed to one
    // observation by its content alone, so the message stays general and the
    // cause travels in `context.diagnostics` for a consumer to match by code.
    throw new PflError(
      `could not read the resolved snapshot for ${requestedId}`,
      EXIT_CODES.CONFIG_ERROR,
      context,
    );
  }
  return { resolvedId: run.resolvedId, diagnostics };
}

/**
 * A scan that could not read a store directory is a store failure, not an
 * empty history: propagating it keeps a broken store from masquerading as
 * "no snapshots" (exit 2) when the contract reserves exit 6 for it (#180).
 */
function throwOnStoreFailure(diagnostics: Diagnostic[]): void {
  const failure = diagnostics.find((entry) => entry.code === 'snapshot-store-unreadable');
  if (failure !== undefined) {
    throw new PflError(failure.message, EXIT_CODES.SNAPSHOT_STORE_FAILED, { diagnostics });
  }
}
