import { homedir } from 'node:os';
import { HARNESS_FACETS, type HarnessFacet } from '../core/facets.js';
import type { ObservedElement } from '../core/observed.js';
import type { ResolvedElement, ResolvedStatus } from '../core/resolved.js';
import { canonicalJsonStringify } from '../util/json.js';
import { redactingLogger } from '../redact/output.js';
import type { Logger } from '../util/logger.js';
import { EXIT_CODES, PflError } from './exit-codes.js';
import { loadInterpretation, type InterpretedRun } from './read.js';

export interface DiffOptions {
  json?: boolean;
  /** Injected for tests; defaults to the current user's home. */
  home?: string;
}

interface StatusChange {
  id: string;
  from: ResolvedStatus | null;
  to: ResolvedStatus | null;
}

export interface DiffResult {
  runtimeId: string;
  observedSnapshotIdA: string;
  observedSnapshotIdB: string;
  resolvedSnapshotIdA: string;
  resolvedSnapshotIdB: string;
  structural: {
    added: number;
    removed: number;
    changed: number;
    addedIds: string[];
    removedIds: string[];
    changedIds: string[];
  };
  effective: {
    newlyEffective: number;
    noLongerEffective: number;
    activationChanged: number;
    statusChanges: StatusChange[];
  };
  facetDeltas: Record<HarnessFacet, number>;
  versionNotes: string[];
}

/**
 * `pfl diff <a> <b>` (design doc §15, §28): a descriptive comparison across three
 * levels — structural, effective-state, and semantic facet. It never says
 * whether a change improved or harmed outcomes, and never rewrites either
 * snapshot.
 *
 * Refuses snapshots from different projects or runtimes. A runtime-version or
 * semantics-version difference is allowed and reported, because resolution can
 * change even when the harness content is identical (§15).
 */
export async function runDiff(
  cwd: string,
  snapshotA: string,
  snapshotB: string,
  options: DiffOptions,
  logger: Logger,
): Promise<void> {
  const home = options.home ?? homedir();
  const out = redactingLogger(logger, options.json ? 'export' : 'display', { home });
  const runA = await loadInterpretation(cwd, snapshotA, home);
  const runB = await loadInterpretation(cwd, snapshotB, home);
  for (const diagnostic of [...runA.diagnostics, ...runB.diagnostics]) {
    out.warn(diagnostic.message, { code: diagnostic.code, path: diagnostic.path ?? undefined });
  }

  const result = computeDiff(runA, runB);
  if (options.json) {
    out.info('diff', {
      runtime: result.runtimeId,
      resolvedSnapshotIdA: result.resolvedSnapshotIdA,
      resolvedSnapshotIdB: result.resolvedSnapshotIdB,
      structural: result.structural,
      effective: result.effective,
      facetDeltas: result.facetDeltas,
      versionNotes: result.versionNotes,
    });
    return;
  }

  out.info('Harness Diff');
  out.info(`Snapshot ${result.resolvedSnapshotIdA} → ${result.resolvedSnapshotIdB}`);
  out.info('');
  out.info('Changes');
  out.info(`  + ${result.structural.added} added`);
  out.info(`  - ${result.structural.removed} removed`);
  out.info(`  ~ ${result.structural.changed} changed`);
  out.info('');
  out.info('Effective changes');
  out.info(`  + ${result.effective.newlyEffective} newly effective`);
  out.info(`  - ${result.effective.noLongerEffective} no longer effective`);
  out.info(`  ~ ${result.effective.activationChanged} activation changed`);
  out.info('');
  out.info('Semantic impact');
  for (const facet of HARNESS_FACETS) {
    const delta = result.facetDeltas[facet];
    out.info(`  ${capitalize(facet).padEnd(14, ' ')}${delta > 0 ? `+${delta}` : `${delta}`}`);
  }
  if (result.versionNotes.length > 0) {
    out.info('');
    for (const note of result.versionNotes) {
      out.warn(`⚠ ${note}`);
    }
  }
}

export function computeDiff(a: InterpretedRun, b: InterpretedRun): DiffResult {
  if (a.observed.project.id !== b.observed.project.id) {
    throw new PflError(
      `cannot diff snapshots from different projects: A belongs to ${a.observed.project.id}, B to ${b.observed.project.id}`,
      EXIT_CODES.CONFIG_ERROR,
    );
  }
  if (a.resolved.runtime.id !== b.resolved.runtime.id) {
    throw new PflError(
      `cannot diff snapshots from different runtimes: A is ${a.resolved.runtime.id}, B is ${b.resolved.runtime.id}`,
      EXIT_CODES.CONFIG_ERROR,
    );
  }

  return {
    runtimeId: a.resolved.runtime.id,
    observedSnapshotIdA: a.observed.snapshotId,
    observedSnapshotIdB: b.observed.snapshotId,
    resolvedSnapshotIdA: a.resolved.snapshotId,
    resolvedSnapshotIdB: b.resolved.snapshotId,
    structural: structuralDiff(a, b),
    effective: effectiveDiff(a, b),
    facetDeltas: facetDeltas(a, b),
    versionNotes: versionNotes(a, b),
  };
}

function structuralDiff(a: InterpretedRun, b: InterpretedRun): DiffResult['structural'] {
  // Compare element by element. `harnessContentDigest` intentionally excludes
  // opaque layers, so it cannot stand in for structural equality — an
  // opaque-only change would be missed. Both snapshots are already in memory, so
  // there is no filesystem re-walk to avoid.
  const byIdA = new Map(a.observed.elements.map((element) => [element.id, element]));
  const byIdB = new Map(b.observed.elements.map((element) => [element.id, element]));

  const addedIds: string[] = [];
  const removedIds: string[] = [];
  const changedIds: string[] = [];
  for (const element of a.observed.elements) {
    const other = byIdB.get(element.id);
    if (other === undefined) removedIds.push(element.id);
    else if (!sameElement(element, other)) changedIds.push(element.id);
  }
  for (const element of b.observed.elements) {
    if (!byIdA.has(element.id)) addedIds.push(element.id);
  }

  addedIds.sort(byId);
  removedIds.sort(byId);
  changedIds.sort(byId);
  return {
    added: addedIds.length,
    removed: removedIds.length,
    changed: changedIds.length,
    addedIds,
    removedIds,
    changedIds,
  };
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Structural equality of two observed elements that share an id. Runtime,
 * origin, path, and kind are part of the id (ADR 0003), so for elements built
 * under the current derivation they cannot differ here; the element's scope and
 * content are compared explicitly.
 *
 * `native.kind` is compared anyway, and must stay. It can never fire for two
 * elements built under the current derivation, but a snapshot captured under the
 * previous one — where the id covered runtime, origin and path only — can pair
 * one id with two kinds: `.codex/skills/AGENTS.md` was recorded as `instructions`
 * in one capture and as `skills` in another. Dropping the comparison reports that
 * pair as unchanged, and the compatibility promise is that an old snapshot diffs
 * against another old snapshot exactly as before.
 */
function sameElement(a: ObservedElement, b: ObservedElement): boolean {
  return (
    a.native.kind === b.native.kind &&
    a.native.scope === b.native.scope &&
    a.source.digest === b.source.digest &&
    canonicalJsonStringify(a.metadata) === canonicalJsonStringify(b.metadata)
  );
}

function effectiveDiff(a: InterpretedRun, b: InterpretedRun): DiffResult['effective'] {
  const byIdA = new Map<string, ResolvedElement>(
    a.resolved.elements.map((element) => [element.id, element]),
  );
  const byIdB = new Map<string, ResolvedElement>(
    b.resolved.elements.map((element) => [element.id, element]),
  );
  const ids = new Set<string>([...byIdA.keys(), ...byIdB.keys()]);

  let newlyEffective = 0;
  let noLongerEffective = 0;
  let activationChanged = 0;
  const statusChanges: StatusChange[] = [];

  for (const id of ids) {
    const elementA = byIdA.get(id);
    const elementB = byIdB.get(id);
    const statusA = elementA?.status ?? null;
    const statusB = elementB?.status ?? null;
    if (statusA !== 'effective' && statusB === 'effective') newlyEffective += 1;
    if (statusA === 'effective' && statusB !== 'effective') noLongerEffective += 1;
    if (
      elementA !== undefined &&
      elementB !== undefined &&
      elementA.activation !== elementB.activation
    ) {
      activationChanged += 1;
    }
    if (elementA !== undefined && elementB !== undefined && statusA !== statusB) {
      statusChanges.push({ id, from: statusA, to: statusB });
    }
  }

  statusChanges.sort((x, y) => byId(x.id, y.id));
  return { newlyEffective, noLongerEffective, activationChanged, statusChanges };
}

function facetDeltas(a: InterpretedRun, b: InterpretedRun): Record<HarnessFacet, number> {
  const count = (run: InterpretedRun, facet: HarnessFacet): number =>
    run.interpretation.elements.filter((element) => element.facets.includes(facet)).length;
  const deltas = {} as Record<HarnessFacet, number>;
  for (const facet of HARNESS_FACETS) {
    deltas[facet] = count(b, facet) - count(a, facet);
  }
  return deltas;
}

function versionNotes(a: InterpretedRun, b: InterpretedRun): string[] {
  const notes: string[] = [];
  if (a.resolved.runtime.version !== b.resolved.runtime.version) {
    notes.push(
      `runtime version differs: ${a.resolved.runtime.version ?? 'unknown'} → ${
        b.resolved.runtime.version ?? 'unknown'
      }`,
    );
  }
  if (a.resolved.resolution.semanticsVersion !== b.resolved.resolution.semanticsVersion) {
    notes.push(
      `resolution semantics differ: ${a.resolved.resolution.semanticsVersion} → ${b.resolved.resolution.semanticsVersion}`,
    );
  }
  return notes;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
