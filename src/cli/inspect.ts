import { homedir } from 'node:os';
import type { ObservedSnapshot } from '../core/observed.js';
import type { ResolvedSnapshot, ResolvedStatus } from '../core/resolved.js';
import { resolveAccessPolicy, type ConsentIO } from '../discovery/consent.js';
import { resolveProjectContext } from '../discovery/project-identity.js';
import { resolveHarness } from '../resolution/resolver.js';
import { getAdapter, getConsentRequest } from '../runtime/registry.js';
import type { RuntimeDetection } from '../runtime/types.js';
import {
  writeLatestPointer,
  writeObservedSnapshot,
  writeResolvedSnapshot,
} from '../snapshot/store.js';
import type { Logger } from '../util/logger.js';

export interface InspectOptions {
  runtime: string;
  json?: boolean;
  /** Injected for tests; defaults to the current user's home. */
  home?: string;
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
): Promise<void> {
  const adapter = getAdapter(options.runtime);
  const project = await resolveProjectContext(cwd);
  const home = options.home ?? homedir();

  const request = getConsentRequest(adapter.id());
  const interactive =
    options.interactive ??
    (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY) && options.json !== true);
  const access = await resolveAccessPolicy(request, {
    home,
    interactive,
    ...(options.io !== undefined ? { io: options.io } : {}),
  });

  const detection = await adapter.detect(project, access, home);
  const observed = await adapter.discover(project, access, home);
  const resolved = await resolveHarness(adapter, observed);

  await writeObservedSnapshot(project.id, observed, home);
  await writeResolvedSnapshot(project.id, resolved, home);
  await writeLatestPointer(
    project.id,
    { observed: observed.snapshotId, resolved: resolved.snapshotId },
    home,
  );

  renderInspect(logger, request.runtimeName, observed, resolved, detection, options.json === true);
}

function countStatus(resolved: ResolvedSnapshot, status: ResolvedStatus): number {
  return resolved.elements.filter((element) => element.status === status).length;
}

function renderInspect(
  logger: Logger,
  runtimeName: string,
  observed: ObservedSnapshot,
  resolved: ResolvedSnapshot,
  detection: RuntimeDetection,
  json: boolean,
): void {
  const opaqueLayers = observed.elements.filter(
    (element) => element.inspectability === 'opaque',
  ).length;
  const counts = {
    effective: countStatus(resolved, 'effective'),
    conditional: countStatus(resolved, 'conditional'),
    shadowed: countStatus(resolved, 'shadowed'),
  };

  if (json) {
    logger.info('inspect', {
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
        ...counts,
        confidence: resolved.resolution.confidence,
      },
      diagnostics: { observed: observed.diagnostics, resolved: resolved.diagnostics },
    });
    return;
  }

  logger.info(`Inspecting ${runtimeName} harness...`);
  logger.info('');
  logger.info(`Observed        ${observed.elements.length} elements`);
  logger.info(`Effective       ${counts.effective}`);
  logger.info(`Conditional     ${counts.conditional}`);
  logger.info(`Shadowed        ${counts.shadowed}`);
  logger.info(`Opaque layers   ${opaqueLayers}`);
  logger.info('');
  logger.info('Snapshot');
  logger.info(`  observed   ${observed.snapshotId}`);
  logger.info(`  resolved   ${resolved.snapshotId}`);

  if (detection.runtimeCompatibility === 'unverified') {
    logger.info('');
    logger.warn(
      detection.version === null
        ? `⚠ ${runtimeName} version could not be verified against this adapter.`
        : `⚠ ${runtimeName} ${detection.version} is outside the verified adapter range.`,
    );
    logger.info('  Resolution results are best-effort.');
  }

  logger.info('');
  logger.info('Run:');
  logger.info('  pfl report');
  logger.info('  pfl graph');
  logger.info('  pfl diff');
}
