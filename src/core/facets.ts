/**
 * Initial semantic facets (design doc §6). Facets are additive: readers must
 * tolerate unknown future facets, so persisted interpretation data is never
 * rejected solely because it carries a facet this build does not know.
 */
export const HARNESS_FACETS = [
  'instructions',
  'knowledge',
  'memory',
  'actions',
  'delegation',
  'controls',
] as const;

export type HarnessFacet = (typeof HARNESS_FACETS)[number];

export function isHarnessFacet(value: string): value is HarnessFacet {
  return (HARNESS_FACETS as readonly string[]).includes(value);
}
