import { homedir } from 'node:os';
import { HARNESS_FACETS, isHarnessFacet, type HarnessFacet } from '../core/facets.js';
import type { NativeOrigin } from '../core/observed.js';
import type { ResolvedStatus } from '../core/resolved.js';
import { redactingLogger } from '../redact/output.js';
import type { Logger } from '../util/logger.js';
import { EXIT_CODES, PflError } from './exit-codes.js';
import { loadInterpretation } from './read.js';

export interface ListOptions {
  snapshot?: string;
  facet?: string;
  origin?: string;
  status?: string;
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
  kind: string;
  origin: NativeOrigin;
  status: ResolvedStatus;
  facets: HarnessFacet[];
}

/**
 * `pfl list [--facet <f>] [--origin <o>] [--status <s>]` (design doc §23): list
 * the elements of the default `latest` snapshot. Filters combine with AND; an
 * invalid filter value fails and lists the valid ones instead of silently
 * returning nothing.
 */
export async function runList(cwd: string, options: ListOptions, logger: Logger): Promise<void> {
  const facet = validateFacet(options.facet);
  const origin = validateOrigin(options.origin);
  const status = validateStatus(options.status);
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
  const resolvedById = new Map(resolved.elements.map((element) => [element.id, element]));
  const interpretationById = new Map(
    interpretation.elements.map((element) => [element.elementId, element]),
  );

  const rows: ListRow[] = observed.elements
    .map((element) => ({
      id: element.id,
      kind: element.native.kind,
      origin: element.native.origin,
      status: resolvedById.get(element.id)?.status ?? ('unknown' as ResolvedStatus),
      facets: interpretationById.get(element.id)?.facets ?? [],
    }))
    .filter(
      (row) =>
        (facet === undefined || row.facets.includes(facet)) &&
        (origin === undefined || row.origin === origin) &&
        (status === undefined || row.status === status),
    );

  if (options.json) {
    out.info('list', { count: rows.length, elements: rows });
    return;
  }
  if (rows.length === 0) {
    out.info('No elements match.');
    return;
  }
  for (const row of rows) {
    out.info(`${row.id}  ${row.kind}  ${row.origin}  ${row.status}  ${row.facets.join(',')}`);
  }
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
