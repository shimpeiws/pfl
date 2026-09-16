import { dirname } from 'node:path';
import type { ElementId } from '../../core/ids.js';
import type { ObservedElement, ObservedSnapshot } from '../../core/observed.js';
import type {
  Activation,
  Applicability,
  Relation,
  ResolvedSnapshot,
  ResolutionStrategy,
} from '../../core/resolved.js';
import { assembleResolvedSnapshot } from '../../resolution/assemble.js';
import { resolveElements, type ElementResolutionInput } from '../../resolution/resolver.js';

/**
 * Codex resolution rules, verified against Codex 0.154.0 (design doc §11,
 * §31.2, §4.3). Each observed element's kind maps to the four resolution axes;
 * the core derives the status. Nothing here runs the runtime.
 *
 * ```text
 * kind                          applicability       strategy        activation
 * instructions                  project | global    accumulate      always
 * fallback-instructions         project             override        always   (replaces AGENTS.md)
 * skills                        project             available       on-demand (still effective)
 * custom-agents                 project             available       on-demand
 * permissions                   global              policy          always
 * memory                        project             accumulate      always
 * hooks                         tool-event(target)  event-pipeline  event-driven
 * approval-sandbox              global              policy          always
 * compaction-controls           global              policy          always   (behavioral control)
 * mcp-configuration             global              available       on-demand
 * runtime-provided-instructions runtime-defined     runtime-defined always   (opaque)
 * anything else                 unknown             unknown         unknown  (unresolved)
 * ```
 *
 * `AGENTS.override.md` takes precedence over `AGENTS.md` in the same scope, so
 * the base file is `shadowed` when an override is present. Codex has no
 * project-scoped configuration directory, so there is no cross-scope settings
 * shadowing to apply. Skill dependencies are recorded as observed structure,
 * never inferred.
 */

export async function resolveCodex(observed: ObservedSnapshot): Promise<ResolvedSnapshot> {
  const shadowedBy = overrideShadowing(observed.elements);

  const inputs: ElementResolutionInput[] = observed.elements.map((element) => {
    const axes = axesFor(element);
    const by = shadowedBy.get(element.id);
    return {
      id: element.id,
      ...axes,
      ...(by !== undefined ? { shadowedBy: by } : {}),
    };
  });

  const relations: Relation[] = [];
  for (const [loser, winner] of shadowedBy) {
    relations.push({ type: 'overrides', from: winner, to: loser });
    relations.push({ type: 'shadows', from: winner, to: loser });
  }

  return assembleResolvedSnapshot({
    observed,
    elements: resolveElements(inputs),
    relations,
  });
}

function axesFor(element: ObservedElement): {
  applicability: Applicability;
  strategy: ResolutionStrategy;
  activation: Activation;
} {
  if (element.status !== 'observed') {
    return { applicability: { type: 'unknown' }, strategy: 'unknown', activation: 'unknown' };
  }

  switch (element.native.kind) {
    case 'instructions':
      return {
        applicability: { type: element.native.origin === 'project' ? 'project' : 'global' },
        strategy: 'accumulate',
        activation: 'always',
      };
    case 'fallback-instructions':
      return { applicability: { type: 'project' }, strategy: 'override', activation: 'always' };
    case 'skills':
    case 'custom-agents':
      return { applicability: { type: 'project' }, strategy: 'available', activation: 'on-demand' };
    case 'memory':
      return { applicability: { type: 'project' }, strategy: 'accumulate', activation: 'always' };
    case 'permissions':
    case 'approval-sandbox':
    case 'compaction-controls':
      return { applicability: { type: 'global' }, strategy: 'policy', activation: 'always' };
    case 'mcp-configuration':
      return { applicability: { type: 'global' }, strategy: 'available', activation: 'on-demand' };
    case 'hooks':
      return {
        applicability: { type: 'tool-event', ...eventTarget(element) },
        strategy: 'event-pipeline',
        activation: 'event-driven',
      };
    case 'runtime-provided-instructions':
      return {
        applicability: { type: 'runtime-defined' },
        strategy: 'runtime-defined',
        activation: 'always',
      };
    default:
      return { applicability: { type: 'unknown' }, strategy: 'unknown', activation: 'unknown' };
  }
}

function eventTarget(element: ObservedElement): { target?: string } {
  const events = element.metadata['eventNames'];
  if (!Array.isArray(events)) return {};
  const names = events.filter((value): value is string => typeof value === 'string');
  return names.length > 0 ? { target: names.join(',') } : {};
}

/**
 * `AGENTS.override.md` shadows the base `AGENTS.md` in the *same directory* (and
 * therefore the same scope) — never across directories. The directory is derived
 * from the element path, so a nested override cannot shadow an unrelated base.
 */
function overrideShadowing(elements: readonly ObservedElement[]): Map<ElementId, ElementId> {
  const overridesByDirectory = new Map<string, ElementId>();
  for (const element of elements) {
    if (element.native.kind !== 'fallback-instructions') continue;
    const path = element.source.path;
    if (path === undefined) continue;
    const directory = dirname(path);
    if (!overridesByDirectory.has(directory)) {
      overridesByDirectory.set(directory, element.id);
    }
  }

  const shadowed = new Map<ElementId, ElementId>();
  for (const element of elements) {
    if (element.native.kind !== 'instructions') continue;
    const path = element.source.path;
    if (path === undefined) continue;
    const override = overridesByDirectory.get(dirname(path));
    if (override !== undefined) {
      shadowed.set(element.id, override);
    }
  }
  return shadowed;
}
