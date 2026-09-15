import { homedir } from 'node:os';
import type { ObservedSnapshot } from '../core/observed.js';
import { resolveAccessPolicy, type ConsentIO } from '../discovery/consent.js';
import { resolveProjectContext } from '../discovery/project-identity.js';
import { getAdapter, getConsentRequest } from '../runtime/registry.js';
import type { RuntimeDetection } from '../runtime/types.js';
import { writeLatestSnapshotId, writeSnapshot } from '../snapshot/store.js';
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
 * identity, request consent, detect the runtime, discover its harness, persist
 * an immutable snapshot, and print the summary.
 *
 * Inspects one runtime at a time. A `partial` snapshot is a success with
 * diagnostics, not a failure. Resolved-fact counts (Effective / Conditional /
 * Shadowed) arrive with resolution (M2) and are not printed yet.
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

  const detection = await adapter.detect(project, access);
  const snapshot = await adapter.discover(project, access);

  await writeSnapshot(project.id, snapshot, home);
  await writeLatestSnapshotId(project.id, snapshot.snapshotId, home);

  renderInspect(logger, request.runtimeName, snapshot, detection, options.json === true);
}

function renderInspect(
  logger: Logger,
  runtimeName: string,
  snapshot: ObservedSnapshot,
  detection: RuntimeDetection,
  json: boolean,
): void {
  const opaqueLayers = snapshot.elements.filter(
    (element) => element.inspectability === 'opaque',
  ).length;

  if (json) {
    logger.info('inspect', {
      runtime: snapshot.runtime.id,
      runtimeVersion: snapshot.runtime.version,
      runtimeCompatibility: snapshot.adapter.runtimeCompatibility,
      project: snapshot.project.id,
      observed: {
        snapshotId: snapshot.snapshotId,
        elements: snapshot.elements.length,
        opaqueLayers,
        completeness: snapshot.completeness,
      },
      diagnostics: snapshot.diagnostics,
    });
    return;
  }

  logger.info(`Inspecting ${runtimeName} harness...`);
  logger.info('');
  logger.info(`Observed        ${snapshot.elements.length} elements`);
  logger.info(`Opaque layers   ${opaqueLayers}`);
  logger.info('');
  logger.info('Snapshot');
  logger.info(`  observed   ${snapshot.snapshotId}`);

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
