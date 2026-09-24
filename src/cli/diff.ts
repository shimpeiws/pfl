import { homedir } from 'node:os';
import { HARNESS_FACETS, type HarnessFacet } from '../core/facets.js';
import type { Diagnostic } from '../core/diagnostics.js';
import type { Finding } from '../core/interpretation.js';
import type { ObservedElement } from '../core/observed.js';
import type { RelationType, ResolvedElement, ResolvedStatus } from '../core/resolved.js';
import { canonicalJsonStringify } from '../util/json.js';
import { redactingLogger } from '../redact/output.js';
import { listRuns } from '../snapshot/store.js';
import type { Logger } from '../util/logger.js';
import { type CommandOutcome } from './document.js';
import { EXIT_CODES, PflError } from './exit-codes.js';
import {
  interpretationProvenance,
  loadInterpretation,
  type InterpretedRun,
  type InterpretationProvenance,
} from './read.js';

export interface DiffOptions {
  /** Scope a `latest` operand to this runtime's newest run (#180). */
  runtime?: string;
  json?: boolean;
  /** Injected for tests; defaults to the current user's home. */
  home?: string;
}

interface StatusChange {
  id: string;
  from: ResolvedStatus | null;
  to: ResolvedStatus | null;
}

export interface RelationRef {
  type: RelationType;
  from: string;
  to: string;
}

export interface DiffData {
  runtime: string;
  observedSnapshotIdA: string;
  observedSnapshotIdB: string;
  resolvedSnapshotIdA: string;
  resolvedSnapshotIdB: string;
  structural: DiffResult['structural'];
  effective: DiffResult['effective'];
  facetDeltas: Record<HarnessFacet, number>;
  relations: { added: RelationRef[]; removed: RelationRef[] };
  findings: { added: Finding[]; removed: Finding[] };
  versionNotes: string[];
  /** Each side's classifier version and whether it was stored or recomputed (#84). */
  interpretation: { a: InterpretationProvenance; b: InterpretationProvenance };
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
  relations: { added: RelationRef[]; removed: RelationRef[] };
  findings: { added: Finding[]; removed: Finding[] };
  versionNotes: string[];
}

/**
 * `pfl diff [a] [b]` (design doc §15, §28): a descriptive comparison across three
 * levels — structural, effective-state, and semantic facet. It never says
 * whether a change improved or harmed outcomes, and never rewrites either
 * snapshot.
 *
 * With no operands the pair defaults to previous vs latest within one runtime
 * (#186): B is the run `latest` resolves to (runtime-scoped when `--runtime`
 * is given) and A is the newest stored run for the same runtime before it.
 * A one-operand call keeps `b` on `latest`, consistently with every other read
 * command, so `pfl diff <a>` compares a snapshot against the current one.
 *
 * Refuses snapshots from different projects or runtimes. A runtime-version or
 * semantics-version difference is allowed and reported, because resolution can
 * change even when the harness content is identical (§15).
 */
export async function runDiff(
  cwd: string,
  snapshotA: string | undefined,
  snapshotB: string | undefined,
  options: DiffOptions,
  logger: Logger,
): Promise<CommandOutcome<DiffData>> {
  const home = options.home ?? homedir();
  const out = redactingLogger(logger, options.json ? 'export' : 'display', { home });
  let runA: InterpretedRun;
  let runB: InterpretedRun;
  let pairDiagnostics: Diagnostic[] = [];
  if (snapshotA === undefined) {
    ({ a: runA, b: runB, pairDiagnostics } = await resolveDefaultPair(cwd, home, options.runtime));
  } else {
    runA = await loadInterpretation(cwd, snapshotA, home, options.runtime);
    // The second operand defaults to `latest`, consistently with every other
    // read command, so `pfl diff <a>` compares a snapshot against the current
    // one.
    runB = await loadInterpretation(cwd, snapshotB ?? 'latest', home, options.runtime);
  }
  const diagnostics = [...pairDiagnostics, ...runA.diagnostics, ...runB.diagnostics];
  for (const diagnostic of diagnostics) {
    out.warn(diagnostic.message, { code: diagnostic.code, path: diagnostic.path ?? undefined });
  }

  const result = computeDiff(runA, runB);
  const data: DiffData = {
    runtime: result.runtimeId,
    observedSnapshotIdA: result.observedSnapshotIdA,
    observedSnapshotIdB: result.observedSnapshotIdB,
    resolvedSnapshotIdA: result.resolvedSnapshotIdA,
    resolvedSnapshotIdB: result.resolvedSnapshotIdB,
    structural: result.structural,
    effective: result.effective,
    facetDeltas: result.facetDeltas,
    relations: result.relations,
    findings: result.findings,
    versionNotes: result.versionNotes,
    interpretation: {
      a: interpretationProvenance(runA),
      b: interpretationProvenance(runB),
    },
  };
  const outcome = {
    data,
    diagnostics,
    completeness: combineCompleteness(runA.observed.completeness, runB.observed.completeness),
  };

  if (options.json) return outcome;

  out.info('Harness Diff');
  out.info(`Runtime: ${result.runtimeId}`);
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
  return outcome;
}

/**
 * Resolves the default pair for a bare `pfl diff` (#186): previous vs latest
 * within one runtime. B is whatever `latest` resolves to — the newest stored
 * run for `runtime` when scoped, else the run the latest pointer names — and
 * A is the newest other run of the same runtime. A runtime with only one run
 * has nothing to diff against, so the error says how to create a pair.
 */
async function resolveDefaultPair(
  cwd: string,
  home: string,
  runtime: string | undefined,
): Promise<{ a: InterpretedRun; b: InterpretedRun; pairDiagnostics: Diagnostic[] }> {
  const b = await loadInterpretation(cwd, 'latest', home, runtime);
  const scope = b.resolved.runtime.id;
  const { runs, diagnostics } = await listRuns(b.observed.project.id, home);
  const prior = runs.find(
    (entry) =>
      entry.runtime.id === scope &&
      entry.resolvedId !== null &&
      entry.resolvedId !== b.resolved.snapshotId &&
      entry.observedId !== b.observed.snapshotId,
  );
  if (prior === undefined || prior.resolvedId === null) {
    throw new PflError(
      `only one ${scope} snapshot stored; run \`pfl inspect --runtime ${scope}\` again to create a pair`,
      EXIT_CODES.CONFIG_ERROR,
      diagnostics.length > 0 ? { diagnostics } : {},
    );
  }
  const a = await loadInterpretation(cwd, prior.resolvedId, home, scope);
  return { a, b, pairDiagnostics: diagnostics };
}

/**
 * The envelope's completeness describes the harnesses the command observed.
 * A diff observes two; a partial on either side makes the pair partial, and
 * only two complete sides are complete.
 */
function combineCompleteness(
  a: 'complete' | 'partial' | 'unknown',
  b: 'complete' | 'partial' | 'unknown',
): 'complete' | 'partial' | 'unknown' {
  if (a === 'partial' || b === 'partial') return 'partial';
  if (a === 'complete' && b === 'complete') return 'complete';
  return 'unknown';
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
    relations: relationsDiff(a, b),
    findings: findingsDiff(a, b),
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

/**
 * Relations added and removed between the two resolved snapshots. Identity is
 * `(type, from, to)`; both arrays are ordered by the element ids they join,
 * as element arrays are.
 */
function relationsDiff(a: InterpretedRun, b: InterpretedRun): DiffResult['relations'] {
  const key = (relation: { type: string; from: string; to: string }): string =>
    `${relation.type}\u0000${relation.from}\u0000${relation.to}`;
  const inA = new Set(a.resolved.relations.map(key));
  const inB = new Set(b.resolved.relations.map(key));
  const toRef = (relation: { type: RelationType; from: string; to: string }): RelationRef => ({
    type: relation.type,
    from: relation.from,
    to: relation.to,
  });
  const added = b.resolved.relations
    .filter((relation) => !inA.has(key(relation)))
    .map(toRef)
    .sort(byRelation);
  const removed = a.resolved.relations
    .filter((relation) => !inB.has(key(relation)))
    .map(toRef)
    .sort(byRelation);
  return { added, removed };
}

function byRelation(x: RelationRef, y: RelationRef): number {
  return byId(x.from, y.from) || byId(x.to, y.to) || byId(x.type, y.type);
}

/**
 * Findings added and removed between the two interpretations. Identity is the
 * whole finding (rule, message, and cited elements), so a reworded finding is
 * an add plus a remove. A classifier-version difference is reported separately
 * in `versionNotes`; both sides are still diffed, as `facetDeltas` is.
 */
function findingsDiff(a: InterpretedRun, b: InterpretedRun): DiffResult['findings'] {
  const key = (finding: Finding): string => canonicalJsonStringify(finding);
  const inA = new Set(a.interpretation.findings.map(key));
  const inB = new Set(b.interpretation.findings.map(key));
  const added = b.interpretation.findings
    .filter((finding) => !inA.has(key(finding)))
    .sort(byFinding);
  const removed = a.interpretation.findings
    .filter((finding) => !inB.has(key(finding)))
    .sort(byFinding);
  return { added, removed };
}

function byFinding(x: Finding, y: Finding): number {
  return (
    byId(x.rule, y.rule) ||
    byId(x.elementIds.join('\u0000'), y.elementIds.join('\u0000')) ||
    byId(x.message, y.message)
  );
}

function versionNotes(a: InterpretedRun, b: InterpretedRun): string[] {
  const notes: string[] = [];
  if (a.interpretation.classifier.version !== b.interpretation.classifier.version) {
    notes.push(
      `classifier version differs: ${a.interpretation.classifier.version} → ${b.interpretation.classifier.version}`,
    );
  }
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
