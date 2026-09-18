import { fragmentKeyOf } from '../core/element-path.js';
import type { ElementId } from '../core/ids.js';
import type { Finding } from '../core/interpretation.js';
import type { ObservedElement, ObservedSnapshot } from '../core/observed.js';
import type { ResolvedSnapshot } from '../core/resolved.js';
import { CORE_FINDING_KINDS, type FindingKinds } from './mappings.js';

/**
 * Descriptive findings (design doc §22). A finding states an observation about
 * the harness's structure; it never says whether that structure is good or bad.
 * The words `good`, `bad`, `better`, `worse`, `recommended`, and `ROI` must not
 * appear — a test greps every generated message for them.
 *
 * Thresholds are named constants so a `conditional-heavy` or `broad-tool-access`
 * call is auditable and adjustable, and the message states the observation
 * (numbers) rather than a verdict. Each finding is scoped to the native kind it
 * actually applies to, so a finding never relabels an unrelated element.
 */

export const CONDITIONAL_HEAVY_MIN_COUNT = 5;
export const CONDITIONAL_HEAVY_MIN_RATIO = 0.4;
export const BROAD_TOOL_ACCESS_MIN_ALLOW = 10;

export function deriveFindings(
  observed: ObservedSnapshot,
  resolved: ResolvedSnapshot,
  kinds: FindingKinds = CORE_FINDING_KINDS,
): Finding[] {
  const observedById = new Map<string, ObservedElement>(
    observed.elements.map((element) => [element.id, element]),
  );
  const findings: Finding[] = [
    ...shadowedElement(resolved),
    ...conflictingScope(observed),
    ...opaqueRuntimeLayer(observed),
    ...broadToolAccess(observed, kinds),
    ...conditionalHeavy(resolved),
    ...memoryEnabled(observed, kinds),
    ...subtreeSpecificInstruction(observedById, resolved, kinds),
  ];
  for (const finding of findings) {
    finding.elementIds.sort(byId);
  }
  return findings;
}

function byId(a: ElementId, b: ElementId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function shadowedElement(resolved: ResolvedSnapshot): Finding[] {
  const ids = resolved.elements
    .filter((element) => element.status === 'shadowed')
    .map((element) => element.id);
  if (ids.length === 0) return [];
  return [
    {
      rule: 'shadowed-element',
      message: `${ids.length} element(s) are shadowed by a higher-precedence layer`,
      elementIds: ids,
    },
  ];
}

function conflictingScope(observed: ObservedSnapshot): Finding[] {
  const scopesByKey = new Map<string, { ids: ElementId[]; scopes: Set<string> }>();
  for (const element of observed.elements) {
    const key = settingsKey(element);
    if (key === null) continue;
    const entry = scopesByKey.get(key) ?? { ids: [], scopes: new Set<string>() };
    entry.ids.push(element.id);
    entry.scopes.add(element.native.scope ?? element.native.origin);
    scopesByKey.set(key, entry);
  }

  return [...scopesByKey.entries()]
    .filter(([, entry]) => entry.scopes.size > 1)
    .map(([key, entry]) => ({
      rule: 'conflicting-scope' as const,
      message: `the settings key "${key}" is defined at ${entry.scopes.size} scopes`,
      elementIds: entry.ids,
    }));
}

function opaqueRuntimeLayer(observed: ObservedSnapshot): Finding[] {
  const ids = observed.elements
    .filter(
      (element) =>
        element.inspectability === 'opaque' &&
        element.native.kind === 'runtime-provided-instructions',
    )
    .map((element) => element.id);
  if (ids.length === 0) return [];
  return [
    {
      rule: 'opaque-runtime-layer',
      message: `${ids.length} runtime-provided instruction layer(s) are opaque`,
      elementIds: ids,
    },
  ];
}

function broadToolAccess(observed: ObservedSnapshot, kinds: FindingKinds): Finding[] {
  const findings: Finding[] = [];
  for (const element of observed.elements) {
    if (!kinds.permission.includes(element.native.kind)) continue;
    const allowCount = element.metadata['allowCount'];
    if (typeof allowCount === 'number' && allowCount >= BROAD_TOOL_ACCESS_MIN_ALLOW) {
      findings.push({
        rule: 'broad-tool-access',
        message: `a permission set allows ${allowCount} tools (threshold ${BROAD_TOOL_ACCESS_MIN_ALLOW})`,
        elementIds: [element.id],
      });
    }
  }
  return findings;
}

function conditionalHeavy(resolved: ResolvedSnapshot): Finding[] {
  const total = resolved.elements.length;
  if (total === 0) return [];
  const conditional = resolved.elements.filter((element) => element.status === 'conditional');
  const ratio = conditional.length / total;
  if (conditional.length < CONDITIONAL_HEAVY_MIN_COUNT || ratio < CONDITIONAL_HEAVY_MIN_RATIO) {
    return [];
  }
  return [
    {
      rule: 'conditional-heavy',
      message: `${conditional.length} of ${total} element(s) are conditional (>= ${CONDITIONAL_HEAVY_MIN_RATIO})`,
      elementIds: conditional.map((element) => element.id),
    },
  ];
}

function memoryEnabled(observed: ObservedSnapshot, kinds: FindingKinds): Finding[] {
  const ids = observed.elements
    .filter((element) => kinds.memory.includes(element.native.kind))
    .map((element) => element.id);
  if (ids.length === 0) return [];
  return [
    {
      rule: 'memory-enabled',
      message: `${ids.length} memory element(s) are present`,
      elementIds: ids,
    },
  ];
}

function subtreeSpecificInstruction(
  observedById: ReadonlyMap<string, ObservedElement>,
  resolved: ResolvedSnapshot,
  kinds: FindingKinds,
): Finding[] {
  const ids = resolved.elements
    .filter((element) => {
      const kind = observedById.get(element.id)?.native.kind;
      return (
        element.applicability?.type === 'directory-subtree' &&
        kind !== undefined &&
        kinds.instruction.includes(kind)
      );
    })
    .map((element) => element.id);
  if (ids.length === 0) return [];
  return [
    {
      rule: 'subtree-specific-instruction',
      message: `${ids.length} instruction(s) apply to a directory subtree`,
      elementIds: ids,
    },
  ];
}

function settingsKey(element: ObservedElement): string | null {
  const path = element.source.path;
  return path === undefined ? null : fragmentKeyOf(path);
}
