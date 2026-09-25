import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ElementId } from '../core/ids.js';
import type { Finding, Interpretation } from '../core/interpretation.js';
import type { ObservedElement } from '../core/observed.js';
import type { Relation, ResolutionConfidence, ResolvedElement } from '../core/resolved.js';
import { redactElementSource, redactingLogger } from '../redact/output.js';
import type { Logger } from '../util/logger.js';
import { type CommandOutcome } from './document.js';
import { writeBundle } from './bundle.js';
import { loadInterpretation } from './read.js';

export interface ExportOptions {
  snapshot?: string;
  /** Scope `latest` to this runtime's newest run (#180). */
  runtime?: string;
  json?: boolean;
  /** Write an evidence bundle (harness.json + evidence + manifest) to this directory. */
  bundle?: string;
  /** Injected for tests; defaults to the current user's home. */
  home?: string;
}

/**
 * One element's Observed / Resolved / Derived Interpretation, joined by
 * element id (roadmap #203). Any of the three may be absent — `resolved` when
 * the resolver never produced an entry for the id, `interpretation` when
 * classification did not cover it — and each is `null` rather than omitted,
 * so a consumer never has to distinguish "absent" from "not looked at".
 */
export interface ExportElement {
  id: ElementId;
  observed: ObservedElement;
  resolved: ResolvedElement | null;
  interpretation: Interpretation['elements'][number] | null;
}

/** Which classifier produced the interpretation, and where it came from (#84, #203). */
export interface ExportInterpretationProvenance {
  classifier: Interpretation['classifier'];
  origin: 'stored' | 'recomputed';
}

export interface ExportData {
  project: { id: string; displayName: string };
  runtime: {
    id: string;
    version: string | null;
    adapter: { id: string; version: string; runtimeCompatibility: 'verified' | 'unverified' };
  };
  snapshot: {
    observedSnapshotId: string;
    resolvedSnapshotId: string;
    capturedAt: string;
    schemaVersion: string;
  };
  resolution: { semanticsVersion: string; confidence: ResolutionConfidence };
  elements: ExportElement[];
  relations: Relation[];
  findings: Finding[];
  interpretation: ExportInterpretationProvenance;
}

/**
 * `pfl export [--snapshot <id>]` (roadmap #203): a single machine-readable
 * document carrying the full sanitized IR of a snapshot — Observed Facts,
 * Resolved Facts, Derived Interpretation, relations, and findings, joined by
 * element id. It is a projection over `report` / `list` / `show` / `graph`'s
 * shared read path, not a new analysis layer: it performs no additional
 * classification, adds no findings, and never re-explores the harness. The
 * intent is that a downstream agent (an Analyzer) can build an evidence plan
 * from this one call instead of `list` followed by `show` per element
 * (design doc; roadmap #203).
 *
 * `--json` is the canonical interface, matching the design doc. Without it,
 * `export` prints a human-readable summary (counts, not the IR) rather than
 * the document itself, the same stance every other `--json` command takes.
 */
export async function runExport(
  cwd: string,
  options: ExportOptions,
  logger: Logger,
): Promise<CommandOutcome<ExportData>> {
  const home = options.home ?? homedir();
  const out = redactingLogger(logger, options.json ? 'export' : 'display', { home });
  const run = await loadInterpretation(cwd, options.snapshot, home, options.runtime);
  const { observed, resolved, interpretation } = run;
  for (const diagnostic of run.diagnostics) {
    out.warn(diagnostic.message, { code: diagnostic.code, path: diagnostic.path ?? undefined });
  }

  // Export is meant to stand alone as the full IR, so it carries the inspection
  // diagnostics too — not only the store-read diagnostics `report`/`list`/`show`
  // surface — the same set `inspect` combines for its own envelope. Without
  // them a consumer sees `completeness: "partial"` with no way to tell why
  // (a parse failure, an unverified runtime version) short of a separate
  // `report --explain` call, which defeats the point of one document.
  const diagnostics = [...run.diagnostics, ...observed.diagnostics, ...resolved.diagnostics];

  const resolvedById = new Map(resolved.elements.map((element) => [element.id, element]));
  const interpretationById = new Map(
    interpretation.elements.map((element) => [element.elementId, element]),
  );

  // Every observed element must appear, whether or not it has a resolved or
  // interpreted counterpart (design doc; roadmap #203): information is never
  // silently dropped. Sorted by id, matching `list --json`'s canonical order,
  // so the document is deterministic independent of discovery order.
  const elements: ExportElement[] = [...observed.elements]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((element) => ({
      id: element.id,
      // Re-assert the export redaction at the boundary, the same stance `show`
      // takes: the element comes from a stored artifact, and an artifact that
      // predates redaction (or was tampered with) must not print a raw path.
      observed: redactElementSource(element, { home }),
      resolved: resolvedById.get(element.id) ?? null,
      interpretation: interpretationById.get(element.id) ?? null,
    }));

  const data: ExportData = {
    project: { id: observed.project.id, displayName: observed.project.displayName },
    runtime: {
      id: observed.runtime.id,
      version: observed.runtime.version,
      adapter: observed.adapter,
    },
    snapshot: {
      observedSnapshotId: observed.snapshotId,
      resolvedSnapshotId: resolved.snapshotId,
      capturedAt: observed.capturedAt,
      schemaVersion: observed.schemaVersion,
    },
    resolution: resolved.resolution,
    elements,
    relations: resolved.relations,
    findings: interpretation.findings,
    interpretation: { classifier: interpretation.classifier, origin: run.interpretationOrigin },
  };
  // When --bundle is provided, write the evidence bundle to the specified
  // directory. INV-001: this path only executes when bundle is set; the default
  // export path (no bundle) is unchanged.
  if (options.bundle !== undefined) {
    const bundleDir = resolve(options.bundle);
    await writeBundle(data, elements, { projectRoot: run.canonicalProjectRoot, bundleDir });
    out.info(`Bundle written to ${bundleDir}`);
  }

  const outcome = { data, diagnostics, completeness: observed.completeness };

  if (options.json) return outcome;

  out.info(`Export for ${observed.runtime.id} (${resolved.snapshotId})`);
  out.info(`${observed.project.displayName}`);
  out.info('');
  out.info(`Elements     ${elements.length}`);
  out.info(`Relations    ${resolved.relations.length}`);
  out.info(`Findings     ${interpretation.findings.length}`);
  out.info(`Completeness ${observed.completeness}`);
  if (options.bundle !== undefined) {
    out.info(`Bundle       ${resolve(options.bundle)}`);
  }
  out.info('');
  out.info('This is a machine-oriented document; use --json to consume it.');
  return outcome;
}
