import { dirname } from 'node:path';
import type { ObservedElement, ObservedSnapshot } from '../../core/observed.js';
import type { Applicability, ResolvedSnapshot } from '../../core/resolved.js';
import { assembleResolvedSnapshot } from '../../resolution/assemble.js';
import { resolveElements, type ElementResolutionInput } from '../../resolution/resolver.js';
import type { ResolutionAxes, ResolutionSemantics } from '../types.js';
import { versionSetPosition } from '../version-compat.js';
import { VERIFIED_OPENCODE_SET } from './detect.js';

/**
 * OpenCode resolution rules (model doc §6; design doc §11). Each observed
 * element's kind maps to the four resolution axes; the core derives the status.
 * Nothing here runs the runtime.
 *
 * ```text
 * kind                          applicability       strategy        activation
 * instructions                  global | project |  accumulate      always
 *                               directory-subtree
 * skills                        global | project    available       on-demand
 * commands                      global | project    available       on-demand
 * subagents                     global | project    available       on-demand
 * agents                        global | project    available       on-demand
 * plugin                        global | project    available       on-demand
 * tools                         global | project    available       on-demand
 * references                    config-rule         available       on-demand  (opaque)
 * mcp-configuration             global | project    available       on-demand
 * permissions                   config-rule         policy          always
 * model-configuration           global | project    policy          always
 * compaction-controls           global | project    policy          always
 * shell-environment             global | project    policy          always
 * project-configuration         project             policy          always
 * tooling-configuration         global | project    policy          always
 * runtime-provided-instructions runtime-defined     runtime-defined always     (opaque)
 * config / unknown              unknown             unknown         unknown    (unresolved)
 * ```
 *
 * A config-derived element's applicability follows its declaring scope: a
 * project-scope element is `project`, a user or managed element is `global`. The
 * `plugin` origin is `global` for the same reason.
 *
 * Instruction applicability is derived from where the file sits, not from its
 * origin: `../…` (a parent directory read under consent) is `global`, a file in
 * the project root is `project`, and a nested file governs its own directory
 * subtree — which is what makes the classifier's `subtree-specific-instruction`
 * rule reachable.
 */

/**
 * The resolution semantics for a detected OpenCode version (design doc §17,
 * model doc §0). The verified range is a *set* (1.18.0, 1.18.30, 1.18.31), so
 * `position` is computed from set membership: an unverified version inside the
 * numeric span is not `within`. The branch is deliberately empty of version
 * breakpoints; a future breakpoint is added here, keyed on `position`, so
 * detection never grows version conditionals. Confidence comes from the
 * position, so an `above` version still never blocks (acceptance criterion 12).
 */
export function semanticsFor(version: string | null): ResolutionSemantics {
  return { position: versionSetPosition(version, VERIFIED_OPENCODE_SET), axesFor };
}

export async function resolveOpencode(
  observed: ObservedSnapshot,
  home = '',
): Promise<ResolvedSnapshot> {
  const semantics = semanticsFor(observed.runtime.version);
  const inputs: ElementResolutionInput[] = observed.elements.map((element) => ({
    id: element.id,
    ...semantics.axesFor(element),
  }));

  return assembleResolvedSnapshot({
    observed,
    elements: resolveElements(inputs),
    relations: [],
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
      // A declared target (`instructions` array entry) is `opaque`: pfl records
      // the declaration and never opens it, so it is resolved like a declared
      // reference, not like an observed instruction file (model doc §5.2).
      if (element.inspectability === 'opaque') {
        return {
          applicability: { type: 'config-rule' },
          strategy: 'available',
          activation: 'on-demand',
        };
      }
      return {
        applicability: instructionApplicability(element),
        strategy: 'accumulate',
        activation: 'always',
      };
    case 'skills':
    case 'commands':
    case 'subagents':
    case 'agents':
    case 'plugin':
    case 'tools':
    case 'mcp-configuration':
      return {
        applicability: scopeApplicability(element),
        strategy: 'available',
        activation: 'on-demand',
      };
    case 'references':
      return {
        applicability: { type: 'config-rule' },
        strategy: 'available',
        activation: 'on-demand',
      };
    case 'permissions':
      return { applicability: { type: 'config-rule' }, strategy: 'policy', activation: 'always' };
    case 'model-configuration':
    case 'compaction-controls':
    case 'shell-environment':
    case 'tooling-configuration':
      return {
        applicability: scopeApplicability(element),
        strategy: 'policy',
        activation: 'always',
      };
    case 'project-configuration':
      return { applicability: { type: 'project' }, strategy: 'policy', activation: 'always' };
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

/** The declaring scope decides applicability: project stays project, everything else is global. */
function scopeApplicability(element: ObservedElement): Applicability {
  return element.native.origin === 'project' ? { type: 'project' } : { type: 'global' };
}

/**
 * An instruction file's applicability comes from its directory: a parent read
 * (`../AGENTS.md`) and the user or managed scope are global, the project-root
 * file is project, and a nested file governs its directory subtree.
 */
function instructionApplicability(element: ObservedElement): Applicability {
  if (element.native.origin !== 'project') return { type: 'global' };
  const path = element.source.path;
  if (path === undefined) return { type: 'unknown' };
  const directory = dirname(path);
  if (directory === '..' || directory.startsWith('../')) return { type: 'global' };
  return directory === '.' ? { type: 'project' } : { type: 'directory-subtree', target: directory };
}
