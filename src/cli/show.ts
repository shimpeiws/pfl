import { homedir } from 'node:os';
import type { ElementId } from '../core/ids.js';
import type { Interpretation } from '../core/interpretation.js';
import type { ObservedElement } from '../core/observed.js';
import type { Relation, ResolvedElement } from '../core/resolved.js';
import { redactElementSource, redactingLogger } from '../redact/output.js';
import type { Logger } from '../util/logger.js';
import { type CommandOutcome } from './document.js';
import { EXIT_CODES, PflError } from './exit-codes.js';
import { loadInterpretation } from './read.js';

export interface ShowOptions {
  snapshot?: string;
  json?: boolean;
  /** Injected for tests; defaults to the current user's home. */
  home?: string;
}

export interface ShowData {
  observed: ObservedElement;
  resolved: ResolvedElement | null;
  interpretation: Interpretation['elements'][number] | null;
  relations: Relation[];
  findings: Interpretation['findings'];
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
  const { observed, resolved, interpretation, diagnostics } = await loadInterpretation(
    cwd,
    options.snapshot,
    home,
  );
  for (const diagnostic of diagnostics) {
    out.warn(diagnostic.message, { code: diagnostic.code, path: diagnostic.path ?? undefined });
  }

  const observedElement = observed.elements.find((element) => element.id === elementId);
  if (observedElement === undefined) {
    throw new PflError(`unknown element id: ${elementId}`, EXIT_CODES.CONFIG_ERROR);
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
    // Re-assert the export redaction at the boundary: the element comes from a
    // stored artifact, and an artifact that predates redaction (or was tampered
    // with) must not print a raw path through `--json`.
    observed: redactElementSource(observedElement, { home }),
    resolved: resolvedElement ?? null,
    interpretation: interpretationElement ?? null,
    relations,
    findings,
  };
  if (options.json) {
    return { data, diagnostics, completeness: observed.completeness };
  }

  out.info(`Element ${elementId}`);
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
    for (const relation of relations) {
      out.info(`  ${relation.type}: ${relation.from} -> ${relation.to}`);
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
