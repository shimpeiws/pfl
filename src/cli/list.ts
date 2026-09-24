import { homedir } from 'node:os';
import type { HarnessFacet } from '../core/facets.js';
import type { NativeOrigin } from '../core/observed.js';
import type { ResolvedStatus } from '../core/resolved.js';
import { redactPath, redactingLogger } from '../redact/output.js';
import type { Logger } from '../util/logger.js';
import { type CommandOutcome } from './document.js';
import { validateFacets, validateKinds, validateOrigins, validateStatuses } from './filters.js';
import {
  interpretationProvenance,
  loadInterpretation,
  type InterpretationProvenance,
} from './read.js';

export interface ListOptions {
  snapshot?: string;
  /** Scope `latest` to this runtime's newest run (#180). */
  runtime?: string;
  facet?: string;
  /** Repeatable at the CLI; an element matches when its kind is any of these. */
  kind?: readonly string[];
  origin?: string;
  status?: string;
  /** Maximum number of elements returned; the matched total stays in `total`. */
  limit?: number;
  json?: boolean;
  /** Injected for tests; defaults to the current user's home. */
  home?: string;
}

interface ListRow {
  id: string;
  path?: string;
  kind: string;
  origin: NativeOrigin;
  status: ResolvedStatus;
  facets: HarnessFacet[];
}

export interface ListData {
  /** The runtime the answered snapshot belongs to (#180). */
  runtime: string;
  count: number;
  /** Elements matching the filters before `--limit` truncates (#178). */
  total: number;
  elements: ListRow[];
  /** Which classifier produced the interpretation, and where it came from (#84). */
  interpretation: InterpretationProvenance;
}

/**
 * `pfl list [--facet <f>] [--kind <k>] [--origin <o>] [--status <s>] [--limit
 * <n>]` (design doc §23): list the elements of the default `latest` snapshot.
 * Filters combine with AND (`--kind` is an OR within itself); an invalid filter
 * value fails and lists the valid ones instead of silently returning nothing.
 */
export async function runList(
  cwd: string,
  options: ListOptions,
  logger: Logger,
): Promise<CommandOutcome<ListData>> {
  const facets = validateFacets(options.facet === undefined ? undefined : [options.facet]);
  const kinds = validateKinds(options.kind);
  const origins = validateOrigins(options.origin === undefined ? undefined : [options.origin]);
  const statuses = validateStatuses(options.status === undefined ? undefined : [options.status]);
  const home = options.home ?? homedir();
  const out = redactingLogger(logger, options.json ? 'export' : 'display', { home });

  const run = await loadInterpretation(cwd, options.snapshot, home, options.runtime);
  const { observed, resolved, interpretation, diagnostics } = run;
  for (const diagnostic of diagnostics) {
    out.warn(diagnostic.message, { code: diagnostic.code, path: diagnostic.path ?? undefined });
  }
  const resolvedById = new Map(resolved.elements.map((element) => [element.id, element]));
  const interpretationById = new Map(
    interpretation.elements.map((element) => [element.elementId, element]),
  );

  const rows: ListRow[] = observed.elements
    .map((element) => {
      const path =
        element.source.path !== undefined ? redactPath(element.source.path, { home }) : undefined;
      return {
        id: element.id,
        ...(path !== undefined && { path }),
        kind: element.native.kind,
        origin: element.native.origin,
        status: resolvedById.get(element.id)?.status ?? ('unknown' as ResolvedStatus),
        facets: interpretationById.get(element.id)?.facets ?? [],
      };
    })
    .filter(
      (row) =>
        (facets === undefined || row.facets.some((f) => facets.has(f))) &&
        (kinds === undefined || kinds.has(row.kind)) &&
        (origins === undefined || origins.has(row.origin)) &&
        (statuses === undefined || statuses.has(row.status)),
    );

  // Elements are ordered by id, as the document contract states, so --limit
  // slices after the sort: a discovery-order slice is not a prefix of the
  // unlimited list. The human listing keeps discovery order and slices on its
  // own.
  const elements = [...rows]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, options.limit);
  const limited = rows.slice(0, options.limit);
  const data: ListData = {
    runtime: observed.runtime.id,
    count: elements.length,
    total: rows.length,
    elements,
    interpretation: interpretationProvenance(run),
  };
  const outcome = { data, diagnostics, completeness: observed.completeness };

  if (options.json) return outcome;
  // The runtime stays prominent so an agent can assert which snapshot answered.
  out.info(`Runtime: ${observed.runtime.id} (${resolved.snapshotId})`);
  out.info('');
  if (limited.length === 0) {
    out.info('No elements match.');
    return outcome;
  }
  for (const row of limited) {
    out.info(
      `${displayPath(row.path, row.kind)}  ${row.id}  ${row.kind}  ${row.origin}  ${row.status}  ${row.facets.join(',')}`,
    );
  }
  if (limited.length < rows.length) {
    out.info(`… ${rows.length - limited.length} more element(s) match; raise --limit to see them.`);
  }
  return outcome;
}

/**
 * Derive the human-readable label from a redacted source path and kind.
 * For skills, the parent directory of SKILL.md is the distinguishing part,
 * matching the `catalogIdentity` precedent in
 * src/runtime/opencode/discovery.ts.
 */
function displayPath(path: string | undefined, kind: string): string {
  if (path === undefined) return '(none)';
  if (kind === 'skills' && path.endsWith('/SKILL.md')) {
    const dir = path.slice(0, -'/SKILL.md'.length);
    return dir.length > 0 ? dir : path;
  }
  return path;
}
