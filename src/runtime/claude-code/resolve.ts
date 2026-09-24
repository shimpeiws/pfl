import { basename, dirname } from 'node:path';
import { fragmentKeyOf } from '../../core/element-path.js';
import type { ElementId } from '../../core/ids.js';
import type { ObservedElement, ObservedSnapshot } from '../../core/observed.js';
import type { Applicability, Relation, ResolvedSnapshot } from '../../core/resolved.js';
import { assembleResolvedSnapshot } from '../../resolution/assemble.js';
import { resolveElements, type ElementResolutionInput } from '../../resolution/resolver.js';
import type { ResolutionAxes, ResolutionSemantics } from '../types.js';
import { versionPosition } from '../version-compat.js';
import { eventTarget } from '../scaffold.js';
import { VERIFIED_CLAUDE_CODE_RANGE } from './detect.js';
import { PROJECT_CONFIG_DIR, isMarketplaceCatalogPath } from './paths.js';

/**
 * Claude Code resolution rules, verified against Claude Code 2.1.272 (design doc
 * §11, §27, §31.1). Each observed element's kind maps to the four resolution
 * axes; the core derives the status. Nothing here runs the runtime.
 *
 * ```text
 * kind                          applicability      strategy       activation
 * instructions                  global | project |  accumulate     always
 *                               directory-subtree
 * rules                         project            accumulate     always
 * memory                        project            accumulate     always
 * skills                        project            available      on-demand   (still effective)
 * commands                      project            available      on-demand
 * subagents                     project            available      on-demand
 * plugin                        global             available      on-demand
 * hooks                         tool-event(target) event-pipeline event-driven
 * permissions                   global             policy         always
 * approval-policy               global             policy         always
 * output-style                  global             policy         always
 * mcp-configuration             global             available      on-demand
 * runtime-provided-instructions runtime-defined    runtime-defined always     (opaque)
 * anything else                 unknown            unknown        unknown     (unresolved)
 * ```
 *
 * Instruction applicability is derived from where the file sits, not from its
 * origin: `../…` (a parent directory read under consent) and the user or managed
 * scope are `global`, a file in the project root is `project`, and a nested file
 * governs its own directory subtree — which is what makes the classifier's
 * `subtree-specific-instruction` rule reachable.
 *
 * Settings precedence (highest first): managed `/Library/…/ClaudeCode/settings.json`
 * > project-local `.claude/settings.local.json` > project `.claude/settings.json`
 * > user `~/.claude/settings.json`. The same config key at a lower scope is
 * `shadowed`. Inside one directory, `CLAUDE.local.md` shadows `CLAUDE.md`; the
 * precedence is keyed on the file's directory and never crosses one, so a nested
 * or parent-directory file is independent.
 */

const USER_SETTINGS_RANK = 1;
const PROJECT_SETTINGS_RANK = 2;
const PROJECT_LOCAL_SETTINGS_RANK = 3;
const MANAGED_SETTINGS_RANK = 4;

/**
 * The resolution semantics for a detected Claude Code version (design doc §17,
 * roadmap §5 M7, issue #76). The verified range carries no intra-range
 * breakpoint — the layout reconciliation in `paths.ts` found none — so the one
 * axis mapping `axesFor` encodes applies at every position: `within` and `above`
 * as the verified semantics, `below` as the same mapping applied best-effort.
 * The branch is deliberately empty of breakpoints rather than populated with
 * guesses; a future breakpoint is added here, keyed on `position`, so detection
 * never grows version conditionals. `resolve()` derives snapshot confidence from
 * the position, not from this mapping, so an `above` version still never blocks
 * (acceptance criterion 12).
 */
export function semanticsFor(version: string | null): ResolutionSemantics {
  return { position: versionPosition(version, VERIFIED_CLAUDE_CODE_RANGE), axesFor };
}

export async function resolveClaudeCode(
  observed: ObservedSnapshot,
  home = '',
): Promise<ResolvedSnapshot> {
  const semantics = semanticsFor(observed.runtime.version);
  const shadowedBy = new Map<ElementId, ElementId>([
    ...settingsShadowing(observed.elements),
    ...localInstructionShadowing(observed.elements),
  ]);

  const inputs: ElementResolutionInput[] = observed.elements.map((element) => {
    const axes = semantics.axesFor(element);
    const by = shadowedBy.get(element.id);
    return {
      id: element.id,
      ...axes,
      ...(by !== undefined ? { shadowedBy: by } : {}),
      ...(isMarketplaceCatalog(element) ? { unresolvedReason: MARKETPLACE_CATALOG_REASON } : {}),
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
    home,
    runtimeCompatibility: semantics.position === 'within' ? 'verified' : 'unverified',
  });
}

/**
 * Files under `~/.claude/plugins/marketplaces/` are cloned catalog repositories,
 * not installed plugins — the runtime loads installed plugins from
 * `plugins/cache/`. They resolve `unresolved` with a reason naming the cause
 * instead of being reported as effective harness (#176). `unresolved` (rather
 * than a new status) keeps the frozen schema-1 enum; downstream consumers such
 * as the duplicate-name aggregation (#183) match `MARKETPLACE_CATALOG_REASON`.
 */
export const MARKETPLACE_CATALOG_REASON = 'marketplace catalog clone; the plugin is not installed';

function isMarketplaceCatalog(element: ObservedElement): boolean {
  return isMarketplaceCatalogPath(element.source.path);
}

function axesFor(element: ObservedElement): ResolutionAxes {
  if (element.status !== 'observed') {
    // A skipped, unreadable, or unsupported element cannot be resolved.
    return { applicability: { type: 'unknown' }, strategy: 'unknown', activation: 'unknown' };
  }

  switch (element.native.kind) {
    case 'instructions':
      return {
        applicability: instructionApplicability(element),
        strategy: 'accumulate',
        activation: 'always',
      };
    case 'rules':
    case 'memory':
      return { applicability: { type: 'project' }, strategy: 'accumulate', activation: 'always' };
    case 'skills':
    case 'commands':
    case 'subagents':
      return { applicability: { type: 'project' }, strategy: 'available', activation: 'on-demand' };
    case 'plugin':
      return { applicability: { type: 'global' }, strategy: 'available', activation: 'on-demand' };
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

/**
 * An instruction file's applicability comes from its directory: a parent read
 * (`../CLAUDE.md`), the user scope, and the managed scope are global, the
 * project-root file is project, and a nested file governs its directory subtree.
 */
function instructionApplicability(element: ObservedElement): Applicability {
  if (element.native.origin !== 'project') return { type: 'global' };
  const path = element.source.path;
  if (path === undefined) return { type: 'unknown' };
  const directory = dirname(path);
  if (directory === '..' || directory.startsWith('../')) return { type: 'global' };
  return directory === '.' ? { type: 'project' } : { type: 'directory-subtree', target: directory };
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

/**
 * `CLAUDE.local.md` shadows the base `CLAUDE.md` in the *same directory* only —
 * never across directories. The directory is derived from the element path, so a
 * nested local file cannot shadow an unrelated base.
 */
function localInstructionShadowing(
  elements: readonly ObservedElement[],
): Map<ElementId, ElementId> {
  const localsByDirectory = new Map<string, ElementId>();
  for (const element of elements) {
    // An unavailable file (symlink, hardlink, oversized, unreadable) cannot
    // shadow anything: it is recorded, but it is not in force.
    if (element.native.kind !== 'instructions' || element.status !== 'observed') continue;
    const path = element.source.path;
    if (path === undefined || basename(path) !== 'CLAUDE.local.md') continue;
    const directory = dirname(path);
    if (!localsByDirectory.has(directory)) {
      localsByDirectory.set(directory, element.id);
    }
  }

  const shadowed = new Map<ElementId, ElementId>();
  for (const element of elements) {
    if (element.native.kind !== 'instructions') continue;
    const path = element.source.path;
    if (path === undefined || basename(path) !== 'CLAUDE.md') continue;
    const local = localsByDirectory.get(dirname(path));
    if (local !== undefined) {
      shadowed.set(element.id, local);
    }
  }
  return shadowed;
}

function settingsKeyOf(element: ObservedElement): string | null {
  const path = element.source.path;
  return path === undefined ? null : fragmentKeyOf(path);
}

function settingsRankOf(element: ObservedElement): number | null {
  // Managed settings outrank every other scope. The origin is authoritative, not
  // the path, so an injected managed base in a test still ranks correctly.
  if (element.native.origin === 'managed') return MANAGED_SETTINGS_RANK;
  const path = element.source.path;
  if (path === undefined) return null;
  if (path.startsWith('~/.claude/settings')) return USER_SETTINGS_RANK;
  if (path.startsWith(`${PROJECT_CONFIG_DIR}/settings.local.json`)) {
    return PROJECT_LOCAL_SETTINGS_RANK;
  }
  if (path.startsWith(`${PROJECT_CONFIG_DIR}/settings.json`)) return PROJECT_SETTINGS_RANK;
  return null;
}
