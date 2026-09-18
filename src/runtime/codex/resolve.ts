import { dirname } from 'node:path';
import type { ElementId } from '../../core/ids.js';
import type { ObservedElement, ObservedSnapshot } from '../../core/observed.js';
import type { Applicability, Relation, ResolvedSnapshot } from '../../core/resolved.js';
import { assembleResolvedSnapshot } from '../../resolution/assemble.js';
import { resolveElements, type ElementResolutionInput } from '../../resolution/resolver.js';
import type { ResolutionAxes, ResolutionSemantics } from '../types.js';
import { versionPosition } from '../version-compat.js';
import { eventTarget } from '../scaffold.js';
import { VERIFIED_CODEX_RANGE } from './detect.js';

/**
 * Codex resolution rules, verified against Codex 0.154.0 (design doc §11,
 * §31.2, §4.3). Each observed element's kind maps to the four resolution axes;
 * the core derives the status. Nothing here runs the runtime.
 *
 * ```text
 * kind                          applicability       strategy        activation
 * instructions                  global | project |  accumulate      always
 *                               directory-subtree
 * fallback-instructions         same as instructions override       always   (replaces the same-directory AGENTS.md)
 * rules                         global              accumulate      always
 * skills                        project             available       on-demand (still effective)
 * permissions                   global              policy          always
 * memory                        project             accumulate      always
 * hooks                         tool-event(target)  event-pipeline  event-driven
 * approval-sandbox              global              policy          always
 * shell-environment             global              policy          always   (behavioral control)
 * project-configuration         project             policy          always
 * plugin                        global              available       on-demand
 * model-configuration           global              policy          always   (behavioral control)
 * compaction-controls           global              policy          always   (behavioral control)
 * mcp-configuration             global              available       on-demand
 * runtime-provided-instructions runtime-defined     runtime-defined always   (opaque)
 * anything else                 unknown             unknown         unknown  (unresolved)
 * ```
 *
 * Instruction applicability is derived from where the file sits, not from its
 * origin: `../…` (a parent directory read under consent) is `global`, a file in
 * the project root is `project`, and a nested file governs its own directory
 * subtree — which is what makes the classifier's `subtree-specific-instruction`
 * rule reachable. A non-project instruction file (the user's `~/.codex/AGENTS.md`)
 * stays `global`.
 *
 * `AGENTS.override.md` replaces the base `AGENTS.md` **in the same directory
 * only**; across directories the files are independent and accumulate. The
 * precedence is keyed on the file's directory and never crosses one, so a
 * nested or parent-directory override cannot shadow an unrelated base. Codex
 * stores project-scoped configuration centrally (`[projects.*]`), so there is no
 * cross-scope settings shadowing to apply. Skill dependencies are recorded as
 * observed structure, never inferred.
 */

/**
 * The resolution semantics for a detected Codex version (design doc §17, roadmap
 * §5 M7, issue #76). The verified range carries no intra-range breakpoint — the
 * layout reconciliation in `paths.ts` found none — so the one axis mapping
 * `axesFor` encodes applies at every position: `within` and `above` as the
 * verified semantics, `below` as the same mapping applied best-effort. The branch
 * is deliberately empty of breakpoints rather than populated with guesses; a
 * future breakpoint is added here, keyed on `position`, so detection never grows
 * version conditionals. `resolve()` derives snapshot confidence from the
 * position, not from this mapping, so an `above` version still never blocks
 * (acceptance criterion 12).
 */
export function semanticsFor(version: string | null): ResolutionSemantics {
  return { position: versionPosition(version, VERIFIED_CODEX_RANGE), axesFor };
}

export async function resolveCodex(
  observed: ObservedSnapshot,
  home = '',
): Promise<ResolvedSnapshot> {
  const semantics = semanticsFor(observed.runtime.version);
  const shadowedBy = overrideShadowing(observed.elements);

  const inputs: ElementResolutionInput[] = observed.elements.map((element) => {
    const axes = semantics.axesFor(element);
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
    home,
    runtimeCompatibility: semantics.position === 'within' ? 'verified' : 'unverified',
  });
}

function axesFor(element: ObservedElement): ResolutionAxes {
  if (element.status !== 'observed') {
    return { applicability: { type: 'unknown' }, strategy: 'unknown', activation: 'unknown' };
  }

  switch (element.native.kind) {
    case 'instructions':
      return {
        applicability: instructionApplicability(element),
        strategy: 'accumulate',
        activation: 'always',
      };
    case 'fallback-instructions':
      return {
        applicability: instructionApplicability(element),
        strategy: 'override',
        activation: 'always',
      };
    case 'rules':
      return { applicability: { type: 'global' }, strategy: 'accumulate', activation: 'always' };
    case 'skills':
      return { applicability: { type: 'project' }, strategy: 'available', activation: 'on-demand' };
    case 'plugin':
      return { applicability: { type: 'global' }, strategy: 'available', activation: 'on-demand' };
    case 'memory':
      return { applicability: { type: 'project' }, strategy: 'accumulate', activation: 'always' };
    case 'permissions':
    case 'approval-sandbox':
    case 'model-configuration':
    case 'compaction-controls':
    case 'shell-environment':
      return { applicability: { type: 'global' }, strategy: 'policy', activation: 'always' };
    case 'project-configuration':
      return { applicability: { type: 'project' }, strategy: 'policy', activation: 'always' };
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

/**
 * An instruction file's applicability comes from its directory: a parent read
 * (`../AGENTS.md`) is global, the project-root file is project, and a nested file
 * governs its directory subtree. The user harness instruction file is global by
 * origin, since `~/.codex/AGENTS.md` is not a project-subtree instruction.
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
