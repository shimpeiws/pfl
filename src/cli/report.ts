import { homedir } from 'node:os';
import { HARNESS_FACETS } from '../core/facets.js';
import type { Diagnostic } from '../core/diagnostics.js';
import type { ElementId } from '../core/ids.js';
import type { Finding, HarnessStats } from '../core/interpretation.js';
import type { ObservedElement } from '../core/observed.js';
import { partialCauses } from '../discovery/assemble.js';
import { getRuntimeName } from '../runtime/registry.js';
import { isCompatScope } from '../core/observed.js';
import { redactDiagnostic, redactPath, redactingLogger } from '../redact/output.js';
import type { Logger } from '../util/logger.js';
import { type CommandOutcome } from './document.js';
import {
  interpretationProvenance,
  loadInterpretation,
  type InterpretationProvenance,
} from './read.js';

export interface ReportOptions {
  snapshot?: string;
  /** Scope `latest` to a runtime's newest run (#180). */
  runtime?: string;
  /** Dump the stored observed diagnostics in full (#169). */
  explain?: boolean;
  json?: boolean;
  /** Injected for tests; defaults to the current user's home. */
  home?: string;
}

/**
 * What a finding cites, resolved for the reader (#181): the redacted source
 * path and kind of each referenced element, so `report --json` consumers do
 * not need a `pfl show` call per id. `path` is absent when the element has no
 * source path (e.g. an opaque runtime layer); `path` and `kind` are both
 * absent when the cited id is not in the observed snapshot (store corruption).
 */
export interface FindingElement {
  id: ElementId;
  path?: string;
  kind?: string;
}

export type ReportFinding = Finding & { elements: FindingElement[] };

/** An element whose status made the snapshot `partial` (#169). */
export interface PartialCauseElement {
  id: string;
  path?: string;
  kind: string;
  status: ObservedElement['status'];
  reason?: string;
}

/** Why a snapshot is not `complete`, plus the full stored diagnostics (#169). */
export interface ReportExplanation {
  /** The elements and warning/error diagnostics that make it `partial`. */
  causes: { elements: PartialCauseElement[]; diagnostics: Diagnostic[] };
  /** The stored observed diagnostics in full, including `info`. */
  diagnostics: Diagnostic[];
}

export interface ReportData {
  runtime: string;
  runtimeName: string;
  project: { id: string; displayName: string };
  observedSnapshotId: string;
  resolvedSnapshotId: string;
  confidence: string;
  stats: HarnessStats;
  findings: ReportFinding[];
  /**
   * Compat-scope read counts (#165): OpenCode deliberately reads other agents'
   * config (`claude-compat`, `agents-compat`). The scopes are adapter-defined
   * strings, so they are surfaced as observed counts, never enumerated here.
   */
  compatScopes: { scope: string; count: number }[];
  /** Which classifier produced the interpretation, and where it came from (#84). */
  interpretation: InterpretationProvenance;
  /** Present only under `--explain` (#169). */
  explanation?: ReportExplanation;
}

/**
 * `pfl report [--snapshot <id>]` (design doc §23, §26): render the harness
 * report. It interprets structure — counts, facets, descriptive findings — but
 * never says whether the harness is good or bad.
 */
export async function runReport(
  cwd: string,
  options: ReportOptions,
  logger: Logger,
): Promise<CommandOutcome<ReportData>> {
  const home = options.home ?? homedir();
  const out = redactingLogger(logger, options.json ? 'export' : 'display', { home });
  const run = await loadInterpretation(cwd, options.snapshot, home, options.runtime);
  const { observed, resolved, interpretation, diagnostics } = run;
  for (const diagnostic of diagnostics) {
    out.warn(diagnostic.message, { code: diagnostic.code, path: diagnostic.path ?? undefined });
  }
  const stats = interpretation.stats;
  const runtimeName = getRuntimeName(observed.runtime.id);
  const elementById = new Map(observed.elements.map((element) => [element.id, element]));
  const findings: ReportFinding[] = interpretation.findings.map((finding) => ({
    ...finding,
    elements: finding.elementIds.map((id) => findingElement(id, elementById, home)),
  }));
  const causes = partialCauses(observed.elements, observed.diagnostics);

  const data: ReportData = {
    runtime: observed.runtime.id,
    runtimeName,
    project: { id: observed.project.id, displayName: observed.project.displayName },
    observedSnapshotId: observed.snapshotId,
    resolvedSnapshotId: resolved.snapshotId,
    confidence: resolved.resolution.confidence,
    stats,
    findings,
    compatScopes: compatScopeCounts(observed.elements),
    interpretation: interpretationProvenance(run),
    ...(options.explain === true && {
      explanation: {
        causes: {
          elements: causes.elements.map((element) => partialCauseElement(element, home)),
          diagnostics: causes.diagnostics.map((d) => redactDiagnostic(d, 'export', { home })),
        },
        diagnostics: observed.diagnostics.map((d) => redactDiagnostic(d, 'export', { home })),
      },
    }),
  };

  if (options.json) {
    return { data, diagnostics, completeness: observed.completeness };
  }

  out.info('Harness Report');
  out.info(`${runtimeName} · ${observed.project.displayName}`);
  out.info('');
  out.info(`Effective elements      ${stats.effective}`);
  out.info(`Shadowed                ${stats.shadowed}`);
  out.info(`Conditional             ${stats.conditional}`);
  out.info(`Opaque runtime layers   ${stats.opaque}`);
  out.info('');
  out.info('Semantic facets');
  for (const facet of HARNESS_FACETS) {
    out.info(`  ${capitalize(facet).padEnd(14, ' ')}${stats.byFacet[facet] ?? 0}`);
  }
  out.info('');
  out.info('Notable');
  if (interpretation.findings.length === 0 && data.compatScopes.length === 0) {
    out.info('  (none)');
  } else {
    for (const { scope, count } of data.compatScopes) {
      out.info(`  ${count} element(s) are read through the ${scope} compatibility surface`);
    }
    for (const finding of interpretation.findings) {
      out.info(`  ${finding.message}`);
    }
  }

  if (run.interpretationOrigin === 'recomputed') {
    out.info('');
    out.info(
      `Interpretation recomputed with classifier ${interpretation.classifier.version} (no stored interpretation).`,
    );
  }
  if (resolved.resolution.confidence === 'unverified-runtime-version') {
    out.info('');
    out.warn(
      '⚠ the runtime version is outside the verified adapter range; interpretation is best-effort.',
    );
  }
  if (observed.completeness !== 'complete') {
    out.info('');
    out.warn(`⚠ scan completeness: ${observed.completeness}`);
    if (causes.elements.length > 0) {
      out.info(`  ${causes.elements.length} element(s) not fully observed:`);
      for (const element of causes.elements) {
        out.info(
          `    ${element.status}  ${element.reason ?? 'unknown'}  ${element.native.kind}  ${element.source.path ?? '(none)'}`,
        );
      }
    }
    if (causes.diagnostics.length > 0) {
      out.info(`  ${causes.diagnostics.length} warning/error diagnostic(s):`);
      // A handful of causes are listed verbatim; past that, group by
      // severity+code so a flood (e.g. 79 duplicate-name warnings) collapses
      // into counts and `--explain` stays the full dump.
      if (causes.diagnostics.length <= 5) {
        for (const d of causes.diagnostics) {
          out.info(
            `    ${d.severity} ${d.code}${d.path !== undefined ? `  ${d.path}` : ''}  ${d.message}`,
          );
        }
      } else {
        const byKey = new Map<string, number>();
        for (const d of causes.diagnostics) {
          const key = `${d.severity} ${d.code}`;
          byKey.set(key, (byKey.get(key) ?? 0) + 1);
        }
        for (const [key, count] of byKey) {
          out.info(`    ${count}× ${key}`);
        }
      }
      if (options.explain !== true) {
        out.info('    (use --explain to dump the stored diagnostics)');
      }
    }
  }

  if (options.explain === true && observed.diagnostics.length > 0) {
    out.info('');
    out.info('Observed diagnostics');
    for (const d of observed.diagnostics) {
      out.info(
        `  ${d.severity}  ${d.code}${d.path !== undefined ? `  ${d.path}` : ''}  ${d.message}`,
      );
    }
  }

  return { data, diagnostics, completeness: observed.completeness };
}

function compatScopeCounts(
  elements: readonly { native: { scope: string | null }; status: string }[],
): { scope: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const element of elements) {
    const scope = element.native.scope;
    // The count claims files read through the surface; a skipped, unreadable,
    // or unsupported entry was discovered but not read.
    if (element.status === 'observed' && scope !== null && isCompatScope(scope)) {
      counts.set(scope, (counts.get(scope) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([scope, count]) => ({ scope, count }))
    .sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function findingElement(
  id: ElementId,
  elementById: Map<ElementId, ObservedElement>,
  home: string,
): FindingElement {
  const element = elementById.get(id);
  if (element === undefined) return { id };
  return {
    id,
    ...(element.source.path !== undefined && {
      path: redactPath(element.source.path, { home }),
    }),
    kind: element.native.kind,
  };
}

function partialCauseElement(element: ObservedElement, home: string): PartialCauseElement {
  return {
    id: element.id,
    ...(element.source.path !== undefined && {
      path: redactPath(element.source.path, { home }),
    }),
    kind: element.native.kind,
    status: element.status,
    ...(element.reason !== undefined && { reason: element.reason }),
  };
}
