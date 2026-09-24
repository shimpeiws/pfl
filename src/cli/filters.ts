import { HARNESS_FACETS, isHarnessFacet, type HarnessFacet } from '../core/facets.js';
import type { NativeOrigin } from '../core/observed.js';
import type { ResolvedStatus } from '../core/resolved.js';
import { listElementKinds } from '../runtime/registry.js';
import { EXIT_CODES, PflError } from './exit-codes.js';

/**
 * Shared validation for the element filters `list` and `graph` expose (§23,
 * §27; #161, #178). An invalid value fails with exit 2 naming the valid ones,
 * rather than silently returning nothing. Every filter is repeatable and ORs
 * within itself; filters combine with AND.
 */
export const NATIVE_ORIGINS: readonly NativeOrigin[] = [
  'project',
  'user',
  'managed',
  'plugin',
  'builtin',
  'unknown',
];

export const RESOLVED_STATUSES: readonly ResolvedStatus[] = [
  'effective',
  'shadowed',
  'conditional',
  'unresolved',
  'unknown',
];

function validate<T extends string>(
  values: readonly string[] | undefined,
  valid: readonly T[],
  singular: string,
  plural: string,
): ReadonlySet<T> | undefined {
  if (values === undefined || values.length === 0) return undefined;
  for (const value of values) {
    if (!valid.includes(value as T)) {
      throw new PflError(
        `unknown ${singular}: ${value}; valid ${plural}: ${valid.join(', ')}`,
        EXIT_CODES.CONFIG_ERROR,
      );
    }
  }
  return new Set(values as T[]);
}

export function validateFacets(
  values: readonly string[] | undefined,
): ReadonlySet<HarnessFacet> | undefined {
  if (values === undefined || values.length === 0) return undefined;
  for (const value of values) {
    if (!isHarnessFacet(value)) {
      throw new PflError(
        `unknown facet: ${value}; valid facets: ${HARNESS_FACETS.join(', ')}`,
        EXIT_CODES.CONFIG_ERROR,
      );
    }
  }
  return new Set(values as HarnessFacet[]);
}

export function validateKinds(
  values: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  return validate(values, listElementKinds(), 'kind', 'kinds');
}

export function validateOrigins(
  values: readonly string[] | undefined,
): ReadonlySet<NativeOrigin> | undefined {
  return validate(values, NATIVE_ORIGINS, 'origin', 'origins');
}

export function validateStatuses(
  values: readonly string[] | undefined,
): ReadonlySet<ResolvedStatus> | undefined {
  return validate(values, RESOLVED_STATUSES, 'status', 'statuses');
}

/**
 * `--scope` (#165): compat scopes are adapter-defined strings, not an enum,
 * so the valid set is whatever the snapshot actually observed. An unknown
 * scope fails with the observed list, like the enum-backed filters.
 */
export function validateScopes(
  values: readonly string[] | undefined,
  present: ReadonlySet<string>,
): ReadonlySet<string> | undefined {
  return validate(values, [...present].sort(), 'scope', 'scopes');
}
