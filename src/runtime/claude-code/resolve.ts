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
 * Claude Code resolution rules, verified against Claude Code 2.1.272 (design doc
 * §11, §27, §31.1). Each observed element's kind maps to the four resolution
 * axes; the core derives the status. Nothing here runs the runtime.
 *
 * ```text
 * kind                          applicability      strategy       activation
 * instructions                  project            accumulate     always
 * rules                         project            accumulate     always
 * memory                        project            accumulate     always
 * skills                        project            available      on-demand   (still effective)
 * commands                      project            available      on-demand
 * subagents                     project            available      on-demand
 * hooks                         tool-event(target) event-pipeline event-driven
 * permissions                   global             policy         always
 * approval-policy               global             policy         always
 * output-style                  global             policy         always
 * mcp-configuration             global             available      on-demand
 * runtime-provided-instructions runtime-defined    runtime-defined always     (opaque)
 * anything else                 unknown            unknown        unknown     (unresolved)
 * ```
 *
 * Settings precedence (highest first): project-local `.claude/settings.local.json`
 * > project `.claude/settings.json` > user `~/.claude/settings.json`. The same
 * config key at a lower scope is `shadowed`; managed settings are not discovered
 * yet, so they are not considered.
 */

const USER_SETTINGS_RANK = 1;
const PROJECT_SETTINGS_RANK = 2;
const PROJECT_LOCAL_SETTINGS_RANK = 3;

export async function resolveClaudeCode(observed: ObservedSnapshot): Promise<ResolvedSnapshot> {
  const shadowedBy = settingsShadowing(observed.elements);

  const inputs: ElementResolutionInput[] = observed.elements.map((element) => {
    const axes = axesFor(element);
    const by = shadowedBy.get(element.id);
    return {
      id: element.id,
      ...axes,
      ...(by !== undefined ? { shadowedBy: by } : {}),
    };
  });

  const relations: Relation[] = [...shadowedBy.entries()].map(([loser, winner]) => ({
    type: 'shadows',
    from: winner,
    to: loser,
  }));

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
    // A skipped, unreadable, or unsupported element cannot be resolved.
    return { applicability: { type: 'unknown' }, strategy: 'unknown', activation: 'unknown' };
  }

  switch (element.native.kind) {
    case 'instructions':
    case 'rules':
    case 'memory':
      return { applicability: { type: 'project' }, strategy: 'accumulate', activation: 'always' };
    case 'skills':
    case 'commands':
    case 'subagents':
      return { applicability: { type: 'project' }, strategy: 'available', activation: 'on-demand' };
    case 'hooks':
      return {
        applicability: { type: 'tool-event', ...eventTarget(element) },
        strategy: 'event-pipeline',
        activation: 'event-driven',
      };
    case 'permissions':
    case 'approval-policy':
    case 'output-style':
      return { applicability: { type: 'global' }, strategy: 'policy', activation: 'always' };
    case 'mcp-configuration':
      return { applicability: { type: 'global' }, strategy: 'available', activation: 'on-demand' };
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
 * For each settings key, the highest-precedence element wins; the rest are
 * shadowed by it. Returns loser id -> winner id.
 */
function settingsShadowing(elements: readonly ObservedElement[]): Map<ElementId, ElementId> {
  const winners = new Map<string, { id: ElementId; rank: number }>();
  for (const element of elements) {
    const key = settingsKeyOf(element);
    const rank = settingsRankOf(element);
    if (key === null || rank === null) continue;
    const current = winners.get(key);
    if (current === undefined || rank > current.rank) {
      winners.set(key, { id: element.id, rank });
    }
  }

  const shadowed = new Map<ElementId, ElementId>();
  for (const element of elements) {
    const key = settingsKeyOf(element);
    if (key === null || settingsRankOf(element) === null) continue;
    const winner = winners.get(key);
    if (winner !== undefined && winner.id !== element.id) {
      shadowed.set(element.id, winner.id);
    }
  }
  return shadowed;
}

function settingsKeyOf(element: ObservedElement): string | null {
  const path = element.source.path;
  if (path === undefined) return null;
  const hash = path.indexOf('#');
  return hash === -1 ? null : path.slice(hash + 1);
}

function settingsRankOf(element: ObservedElement): number | null {
  const path = element.source.path;
  if (path === undefined) return null;
  if (path.includes('.claude/settings.local.json')) return PROJECT_LOCAL_SETTINGS_RANK;
  if (path.startsWith('~/.claude/settings.json')) return USER_SETTINGS_RANK;
  if (path.includes('.claude/settings.json')) return PROJECT_SETTINGS_RANK;
  return null;
}
