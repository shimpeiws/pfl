import type { Diagnostic } from '../core/diagnostics.js';
import { formatVersion, highestVersion, parseVersion } from './version-compat.js';

/**
 * Reconciliation of the version sources detection reads (design doc §17,
 * roadmap §5 M7, issue #76). An installation can leave more than one version
 * behind: a stale release directory beside the current one, an npm package
 * beside the installer's own metadata, or an update result that disagrees with
 * the installed binary. Choosing one silently would hide the discrepancy, so the
 * highest parseable version is used and a diagnostic names every disagreeing
 * source.
 *
 * A source is labeled, never pathed. The label is what reaches the diagnostic,
 * so a disagreement cannot leak a raw path or a secret (design doc §19).
 */

/** A detected version and the display-safe source that reported it. */
export interface VersionSource {
  label: string;
  version: string;
}

export interface ReconciledVersions {
  /** The highest parseable version across all sources, normalized, or null. */
  version: string | null;
  /** A warning naming every disagreeing source, or null when the sources agree. */
  diagnostic: Diagnostic | null;
}

export function reconcileVersionSources(sources: readonly VersionSource[]): ReconciledVersions {
  const version = highestVersion(sources.map((source) => source.version));
  const distinct = distinctSources(sources);
  if (distinct.length <= 1) return { version, diagnostic: null };

  const named = distinct
    .map(({ version: reported, labels }) => `${labels.join(' and ')} reports ${reported}`)
    .join('; ');
  return {
    version,
    diagnostic: {
      severity: 'warning',
      code: 'runtime-version-disagreement',
      message: `runtime version sources disagree (${named}); using the highest, ${version ?? 'unknown'}`,
    },
  };
}

/**
 * The distinct normalized versions among the sources, each with the labels that
 * reported it. Two sources with the same version are one entry; two that differ
 * are what makes a disagreement.
 */
function distinctSources(
  sources: readonly VersionSource[],
): { version: string; labels: string[] }[] {
  const byVersion = new Map<string, string[]>();
  for (const source of sources) {
    const parsed = parseVersion(source.version);
    if (parsed === null) continue;
    const normalized = formatVersion(parsed);
    const labels = byVersion.get(normalized) ?? [];
    if (!labels.includes(source.label)) labels.push(source.label);
    byVersion.set(normalized, labels);
  }
  return [...byVersion.entries()].map(([version, labels]) => ({ version, labels }));
}
