import { homedir } from 'node:os';
import type { Diagnostic } from '../core/diagnostics.js';
import type { ElementId } from '../core/ids.js';
import { MAX_ELEMENT_LOOKUP_RUNS } from '../limits.js';
import type { Interpretation } from '../core/interpretation.js';
import type { ObservedElement } from '../core/observed.js';
import type { Relation, ResolvedElement } from '../core/resolved.js';
import { redactElementSource, redactingLogger } from '../redact/output.js';
import { listRuns, readObservedSnapshot, type StoredRunSummary } from '../snapshot/store.js';
import type { Logger } from '../util/logger.js';
import { type CommandOutcome } from './document.js';
import { EXIT_CODES, PflError } from './exit-codes.js';
import {
  interpretationProvenance,
  loadInterpretation,
  throwOnStoreFailure,
  type InterpretedRun,
  type InterpretationProvenance,
} from './read.js';

export interface ShowOptions {
  snapshot?: string;
  /** Scope `latest` to this runtime's newest run (#180). */
  runtime?: string;
  json?: boolean;
  /** Injected for tests; defaults to the current user's home. */
  home?: string;
}

export interface ShowData {
  /** The runtime the answered snapshot belongs to (#180). */
  runtime: string;
  observed: ObservedElement;
  resolved: ResolvedElement | null;
  interpretation: Interpretation['elements'][number] | null;
  relations: Relation[];
  findings: Interpretation['findings'];
  /**
   * Which classifier produced the interpretation, and where it came from (#84).
   * Named `interpretationProvenance` because `interpretation` is already this
   * command's per-element interpretation.
   */
  interpretationProvenance: InterpretationProvenance;
}

/**
 * `pfl show <element-id>` (design doc §23): drill into one element's observed
 * facts, resolved facts, and derived interpretation. This is where provenance
 * pays off — the source path, the resolution reason, relations, and the
 * findings that cite it are all visible at a glance.
 */
export async function runShow(
  cwd: string,
  elementId: string,
  options: ShowOptions,
  logger: Logger,
): Promise<CommandOutcome<ShowData>> {
  const home = options.home ?? homedir();
  const out = redactingLogger(logger, options.json ? 'export' : 'display', { home });
  const run = await loadInterpretation(cwd, options.snapshot, home, options.runtime);
  const { observed, resolved, interpretation, diagnostics } = run;
  for (const diagnostic of diagnostics) {
    out.warn(diagnostic.message, { code: diagnostic.code, path: diagnostic.path ?? undefined });
  }

  const observedElement = observed.elements.find((element) => element.id === elementId);
  if (observedElement === undefined) {
    throw await unknownElementError(elementId, run, options, home);
  }
  const resolvedElement = resolved.elements.find((element) => element.id === elementId);
  const interpretationElement = interpretation.elements.find(
    (element) => element.elementId === elementId,
  );
  const relations = resolved.relations.filter(
    (relation) => relation.from === elementId || relation.to === elementId,
  );
  const findings = interpretation.findings.filter((finding) =>
    finding.elementIds.includes(elementId as ElementId),
  );

  const data: ShowData = {
    runtime: observed.runtime.id,
    // Re-assert the export redaction at the boundary: the element comes from a
    // stored artifact, and an artifact that predates redaction (or was tampered
    // with) must not print a raw path through `--json`.
    observed: redactElementSource(observedElement, { home }),
    resolved: resolvedElement ?? null,
    interpretation: interpretationElement ?? null,
    relations,
    findings,
    interpretationProvenance: interpretationProvenance(run),
  };
  if (options.json) {
    return { data, diagnostics, completeness: observed.completeness };
  }

  out.info(`Element ${elementId}`);
  out.info(`  runtime         ${observed.runtime.id}`);
  out.info(`  kind            ${observedElement.native.kind}`);
  out.info(
    `  origin          ${observedElement.native.origin}${
      observedElement.native.scope !== null ? ` (${observedElement.native.scope})` : ''
    }`,
  );
  out.info(
    `  source          ${observedElement.source.path ?? '(none)'}${
      observedElement.source.digest !== undefined ? `  ${observedElement.source.digest}` : ''
    }`,
  );
  out.info(`  inspectability  ${observedElement.inspectability}`);
  out.info(`  status          ${resolvedElement?.status ?? 'unknown'}`);
  if (resolvedElement !== undefined) {
    out.info(`  activation      ${resolvedElement.activation}`);
    out.info(
      `  applicability   ${resolvedElement.applicability?.type ?? 'unknown'}${
        resolvedElement.applicability?.target !== undefined
          ? ` (${resolvedElement.applicability.target})`
          : ''
      }`,
    );
    out.info(
      `  resolution      ${resolvedElement.resolution.strategy}${
        resolvedElement.resolution.reason !== undefined
          ? ` — ${resolvedElement.resolution.reason}`
          : ''
      }`,
    );
  }
  if (Object.keys(observedElement.metadata).length > 0) {
    out.info(`  metadata        ${JSON.stringify(observedElement.metadata)}`);
  }
  if (interpretationElement !== undefined) {
    out.info(
      `  facets          ${interpretationElement.facets.join(',') || '(none)'}  [${
        interpretationElement.confidence
      }] ${interpretationElement.reason}`,
    );
  }

  if (relations.length > 0) {
    out.info('');
    out.info('Relations');
    const pathById = new Map<ElementId, string | undefined>(
      observed.elements.map((element) => [element.id, element.source.path]),
    );
    const endpoint = (id: ElementId): string => pathById.get(id) ?? id;
    for (const relation of relations) {
      out.info(`  ${relation.type}: ${endpoint(relation.from)} -> ${endpoint(relation.to)}`);
    }
  }
  if (findings.length > 0) {
    out.info('');
    out.info('Findings');
    for (const finding of findings) {
      out.info(`  ${finding.message}`);
    }
  }
  return { data, diagnostics, completeness: observed.completeness };
}

/** Element ids are `el_` + 16 lowercase hex digits (see `elementIdFor`). */
const ELEMENT_ID_PATTERN = /^el_[0-9a-f]{16}$/;

/**
 * Diagnose a missing element id (#168): a malformed id is not an element id at
 * all; a well-formed id may live in another stored run of this project; an id
 * in no stored run gets pointed at `list`/`snapshots`. Reads stay inside the
 * snapshot store — the lookup never touches the harness.
 */
async function unknownElementError(
  elementId: string,
  run: InterpretedRun,
  options: ShowOptions,
  home: string,
): Promise<PflError> {
  if (!ELEMENT_ID_PATTERN.test(elementId)) {
    return new PflError(
      `not an element id: ${elementId} (expected el_<16 hex digits>); run \`pfl list\` to see this snapshot's element ids`,
      EXIT_CODES.CONFIG_ERROR,
    );
  }

  // The candidate list comes from a full run scan — the same store walk
  // `pfl snapshots` performs, so the extra work is the resource strategy the
  // store already accepts (gc keeps run counts small). `MAX_ELEMENT_LOOKUP_RUNS`
  // bounds only the second pass of observation re-reads.
  const { runs, diagnostics } = await listRuns(run.observed.project.id, home);
  // An unreadable store directory is a store failure (exit 6), not a silent
  // "id not found" — the same propagation the read path applies (#180).
  throwOnStoreFailure(diagnostics);
  const context = diagnostics.length > 0 ? { diagnostics } : {};
  const candidates = runs
    .filter((entry) => entry.observedId !== run.observed.snapshotId)
    .slice(0, MAX_ELEMENT_LOOKUP_RUNS);
  for (const candidate of candidates) {
    // A run whose artifact fails to re-read was already reported as a scan
    // diagnostic; skip it rather than aborting the lookup.
    const candidateObserved = await readObservedSnapshot(
      run.observed.project.id,
      candidate.observedId,
      home,
    ).catch(() => null);
    if (candidateObserved?.elements.some((element) => element.id === elementId) === true) {
      return foundInOtherRunError(elementId, candidate, options, context);
    }
  }

  const scannedAll = runs.length - 1 <= MAX_ELEMENT_LOOKUP_RUNS;
  const scope = scannedAll
    ? 'any stored run'
    : `the ${MAX_ELEMENT_LOOKUP_RUNS} most recent stored runs`;
  return new PflError(
    `unknown element id: ${elementId}; not in the selected snapshot or ${scope} — run \`pfl list\` to see this snapshot's elements or \`pfl snapshots\` to list runs`,
    EXIT_CODES.CONFIG_ERROR,
    context,
  );
}

function foundInOtherRunError(
  elementId: string,
  located: StoredRunSummary,
  options: ShowOptions,
  context: { diagnostics?: Diagnostic[] },
): PflError {
  // An observation-only run (an interrupted inspection) has no resolved
  // snapshot to show: suggesting `--snapshot` with its id would fail at the
  // resolution step, so the message says where the element is without
  // promising a runnable command.
  if (located.resolvedId === null) {
    return new PflError(
      `element ${elementId} is in ${located.observedId} (${located.runtime.id}, ${located.capturedAt.slice(0, 10)}), but that run has no readable resolved snapshot, so it cannot be shown`,
      EXIT_CODES.CONFIG_ERROR,
      context,
    );
  }
  // A `--runtime` scope that differs from the located run's runtime would
  // reject `--snapshot`, so the hint has to carry it too.
  const runtimeFlag =
    options.runtime !== undefined && options.runtime !== located.runtime.id
      ? ` --runtime ${located.runtime.id}`
      : '';
  return new PflError(
    `element ${elementId} is in ${located.observedId} (${located.runtime.id}, ${located.capturedAt.slice(0, 10)}), not the selected snapshot; re-run with --snapshot ${located.observedId}${runtimeFlag}`,
    EXIT_CODES.CONFIG_ERROR,
    context,
  );
}
