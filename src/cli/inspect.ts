import { homedir } from 'node:os';
import { classify } from '../classify/classifier.js';
import { deriveFindings } from '../classify/findings.js';
import { generateInterpretationId } from '../core/ids.js';
import type { Interpretation } from '../core/interpretation.js';
import type { ObservedSnapshot } from '../core/observed.js';
import type { ResolvedSnapshot, ResolvedStatus } from '../core/resolved.js';
import { resolveAccessPolicy, type ConsentIO } from '../discovery/consent.js';
import { resolveProjectContext } from '../discovery/project-identity.js';
import { resolveHarness } from '../resolution/resolver.js';
import { getAdapter, getConsentRequest } from '../runtime/registry.js';
import type { RuntimeDetection } from '../runtime/types.js';
import { resolveStoredProjectId } from '../snapshot/project-index.js';
import { SNAPSHOT_SCHEMA_VERSION } from '../snapshot/serialization.js';
import {
  writeInterpretation,
  writeLatestPointer,
  writeObservedSnapshot,
  writeResolvedSnapshot,
} from '../snapshot/store.js';
import { redactingLogger } from '../redact/output.js';
import type { Logger } from '../util/logger.js';
import { type CommandOutcome } from './document.js';

export interface InspectData {
  runtime: string;
  runtimeVersion: string | null;
  runtimeCompatibility: 'verified' | 'unverified';
  project: string;
  observed: {
    snapshotId: string;
    elements: number;
    opaqueLayers: number;
    completeness: string;
  };
  resolved: {
    snapshotId: string;
    effective: number;
    conditional: number;
    shadowed: number;
    confidence: string;
  };
}

export interface InspectOptions {
  runtime: string;
  json?: boolean;
  /** Injected for tests; defaults to the current user's home. */
  home?: string;
  /** Injected for tests; defaults to `process.env.PATH` for non-installer detection. */
  pathValue?: string;
  /** Injected for tests; defaults to whether a TTY is attached. */
  interactive?: boolean;
  /** Injected for tests so the consent prompt needs no TTY. */
  io?: ConsentIO;
}

/**
 * `pfl inspect --runtime <id>` (design doc §9, §23, §25): resolve project
 * identity, request consent, detect the runtime, discover its harness, resolve
 * it, persist both snapshots, and print the summary.
 *
 * Inspects one runtime at a time. A `partial` observed snapshot is a success
 * with diagnostics, not a failure.
 */
export async function runInspect(
  cwd: string,
  options: InspectOptions,
  logger: Logger,
): Promise<CommandOutcome<InspectData>> {
  const adapter = getAdapter(options.runtime);
  const home = options.home ?? homedir();
  const out = redactingLogger(logger, options.json ? 'export' : 'display', { home });

  const request = getConsentRequest(adapter.id());
  const interactive =
    options.interactive ??
    (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY) && options.json !== true);
  const access = await resolveAccessPolicy(request, {
    home,
    interactive,
    ...(options.io !== undefined ? { io: options.io } : {}),
  });

  // Identity is resolved after consent: a `.git` file's `gitdir:` and an
  // ancestor `.git` are out-of-project reads (roadmap S5).
  const context = await resolveProjectContext(cwd, {
    allowExternalGit: access.allowOutsideProject,
  });
  // The stored id is assigned once and pinned by the index, so a later remote
  // change does not move the project's history (roadmap #86).
  const stored = await resolveStoredProjectId(context, home);
  const project = { ...context, id: stored.id };

  const detection = await adapter.detect(project, access, home, options.pathValue);
  const observed = await adapter.discover(project, access, home, options.pathValue);
  const resolved = await resolveHarness(adapter, observed, home);

  await writeObservedSnapshot(project.id, observed, home);
  await writeResolvedSnapshot(project.id, resolved, home);

  // The interpretation is a run artifact, persisted with its siblings so a
  // report reproduces and can name the classifier that produced it (#84). A
  // classification failure must not cost the captured run: the observed and
  // resolved snapshots are already stored, a read recomputes a missing
  // interpretation, and the failure is recorded as a diagnostic.
  const diagnostics = [...stored.diagnostics, ...observed.diagnostics, ...resolved.diagnostics];
  let interpretationId: string | undefined;
  try {
    const interpretation: Interpretation = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      interpretationId: generateInterpretationId(),
      resolvedSnapshotId: resolved.snapshotId,
      ...classify(observed, resolved),
      findings: deriveFindings(observed, resolved),
    };
    await writeInterpretation(project.id, interpretation, home);
    interpretationId = interpretation.interpretationId;
  } catch (error) {
    diagnostics.push({
      severity: 'warning',
      code: 'interpretation-not-stored',
      message: `the interpretation could not be stored and will be recomputed on read: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  await writeLatestPointer(
    project.id,
    {
      observed: observed.snapshotId,
      resolved: resolved.snapshotId,
      ...(interpretationId !== undefined ? { interpretation: interpretationId } : {}),
    },
    home,
  );

  const data = inspectData(observed, resolved);

  if (options.json !== true) {
    renderInspect(out, request.runtimeName, observed, resolved, detection);
  }
  return { data, diagnostics, completeness: observed.completeness };
}

function inspectData(observed: ObservedSnapshot, resolved: ResolvedSnapshot): InspectData {
  const opaqueLayers = observed.elements.filter(
    (element) => element.inspectability === 'opaque',
  ).length;
  return {
    runtime: observed.runtime.id,
    runtimeVersion: observed.runtime.version,
    runtimeCompatibility: observed.adapter.runtimeCompatibility,
    project: observed.project.id,
    observed: {
      snapshotId: observed.snapshotId,
      elements: observed.elements.length,
      opaqueLayers,
      completeness: observed.completeness,
    },
    resolved: {
      snapshotId: resolved.snapshotId,
      effective: countStatus(resolved, 'effective'),
      conditional: countStatus(resolved, 'conditional'),
      shadowed: countStatus(resolved, 'shadowed'),
      confidence: resolved.resolution.confidence,
    },
  };
}

function countStatus(resolved: ResolvedSnapshot, status: ResolvedStatus): number {
  return resolved.elements.filter((element) => element.status === status).length;
}

function renderInspect(
  out: Logger,
  runtimeName: string,
  observed: ObservedSnapshot,
  resolved: ResolvedSnapshot,
  detection: RuntimeDetection,
): void {
  const opaqueLayers = observed.elements.filter(
    (element) => element.inspectability === 'opaque',
  ).length;
  const counts = {
    effective: countStatus(resolved, 'effective'),
    conditional: countStatus(resolved, 'conditional'),
    shadowed: countStatus(resolved, 'shadowed'),
  };

  out.info(`Inspecting ${runtimeName} harness...`);
  out.info('');
  out.info(`Observed        ${observed.elements.length} elements`);
  out.info(`Effective       ${counts.effective}`);
  out.info(`Conditional     ${counts.conditional}`);
  out.info(`Shadowed        ${counts.shadowed}`);
  out.info(`Opaque layers   ${opaqueLayers}`);
  out.info('');
  out.info('Snapshot');
  out.info(`  observed   ${observed.snapshotId}`);
  out.info(`  resolved   ${resolved.snapshotId}`);

  if (detection.runtimeCompatibility === 'unverified') {
    out.info('');
    out.warn(
      detection.version === null
        ? `⚠ ${runtimeName} version could not be verified against this adapter.`
        : `⚠ ${runtimeName} ${detection.version} is outside the verified adapter range.`,
    );
    out.info('  Resolution results are best-effort.');
  }

  out.info('');
  out.info('Run:');
  out.info('  pfl report');
  out.info('  pfl graph');
  out.info('  pfl diff');
}
