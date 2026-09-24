import { homedir } from 'node:os';
import { HARNESS_FACETS, isHarnessFacet, type HarnessFacet } from '../core/facets.js';
import type { NativeOrigin } from '../core/observed.js';
import type { ResolvedStatus } from '../core/resolved.js';
import { redactPath, redactingLogger } from '../redact/output.js';
import { listElementKinds } from '../runtime/registry.js';
import type { Logger } from '../util/logger.js';
import { type CommandOutcome } from './document.js';
import { EXIT_CODES, PflError } from './exit-codes.js';
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

const NATIVE_ORIGINS: readonly NativeOrigin[] = [
  'project',
  'user',
  'managed',
  'plugin',
  'builtin',
  'unknown',
];

const RESOLVED_STATUSES: readonly ResolvedStatus[] = [
  'effective',
  'shadowed',
  'conditional',
  'unresolved',
  'unknown',
];

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
  const facet = validateFacet(options.facet);
  const kinds = validateKinds(options.kind);
  const origin = validateOrigin(options.origin);
  const status = validateStatus(options.status);
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
        (facet === undefined || row.facets.includes(facet)) &&
        (kinds === undefined || kinds.has(row.kind)) &&
        (origin === undefined || row.origin === origin) &&
        (status === undefined || row.status === status),
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

function validateFacet(value: string | undefined): HarnessFacet | undefined {
  if (value === undefined) return undefined;
  if (!isHarnessFacet(value)) {
    throw new PflError(
      `unknown facet: ${value}; valid facets: ${HARNESS_FACETS.join(', ')}`,
      EXIT_CODES.CONFIG_ERROR,
    );
  }
  return value;
}

function validateKinds(values: readonly string[] | undefined): ReadonlySet<string> | undefined {
  if (values === undefined || values.length === 0) return undefined;
  const valid = listElementKinds();
  for (const value of values) {
    if (!valid.includes(value)) {
      throw new PflError(
        `unknown kind: ${value}; valid kinds: ${valid.join(', ')}`,
        EXIT_CODES.CONFIG_ERROR,
      );
    }
  }
  return new Set(values);
}

function validateOrigin(value: string | undefined): NativeOrigin | undefined {
  if (value === undefined) return undefined;
  if (!(NATIVE_ORIGINS as readonly string[]).includes(value)) {
    throw new PflError(
      `unknown origin: ${value}; valid origins: ${NATIVE_ORIGINS.join(', ')}`,
      EXIT_CODES.CONFIG_ERROR,
    );
  }
  return value as NativeOrigin;
}

function validateStatus(value: string | undefined): ResolvedStatus | undefined {
  if (value === undefined) return undefined;
  if (!(RESOLVED_STATUSES as readonly string[]).includes(value)) {
    throw new PflError(
      `unknown status: ${value}; valid statuses: ${RESOLVED_STATUSES.join(', ')}`,
      EXIT_CODES.CONFIG_ERROR,
    );
  }
  return value as ResolvedStatus;
}
