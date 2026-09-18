import { homedir } from 'node:os';
import type { Diagnostic } from '../../core/diagnostics.js';
import { runtimeId } from '../../core/ids.js';
import { readExternalInstall, type ExternalInstallSpec } from '../external-install.js';
import type { RuntimeDetection } from '../types.js';
import { isVersionInSet, versionSetPosition, type VersionSet } from '../version-compat.js';
import { reconcileVersionSources } from '../version-sources.js';

/**
 * Static runtime detection for OpenCode (design doc §8, §17; model doc §0, §1).
 * Reads version metadata from disk; it never spawns the runtime or runs
 * `opencode --version`.
 *
 * ## No installer-managed source
 *
 * Unlike Claude Code and Codex, OpenCode has no installer-managed release
 * directory this adapter models: its data, state, cache, bin, log, and tmp roots
 * are runtime state (model doc §1, §8) and are not harness reads. Detection
 * therefore has one route — the non-installer scanner (`readExternalInstall`):
 * the `opencode` binary by name in a bin directory (Homebrew's `Cellar`, a
 * `bin` under a known prefix, or a `PATH` entry), and a version from a Homebrew
 * `Cellar` version directory. Nothing is executed and no symlink is followed.
 *
 * The npm package name is **not** stated by the model doc, so the spec omits it
 * rather than guessing: a wrong name would read an unrelated manifest.
 *
 * ## The verified range is a set, not a range
 *
 * The measured evidence names exact versions — 1.18.0 (yuurei) and 1.18.30,
 * with the §0 surfaces re-run on 1.18.31 — and explicitly says "discrete
 * versions, not a floor" (model doc §0). A `VersionRange` is continuous, so
 * encoding this as `1.18.0..1.18.31` would claim every version in between was
 * verified. `VERIFIED_OPENCODE_VERSIONS` is therefore a set and membership
 * decides compatibility; a version inside the numeric span that is not a member
 * is unverified, not verified.
 */

export const VERIFIED_OPENCODE_VERSIONS = ['1.18.0', '1.18.30', '1.18.31'] as const;

export const VERIFIED_OPENCODE_SET: VersionSet = { versions: VERIFIED_OPENCODE_VERSIONS };

/**
 * Fixed home-relative prefixes checked for a non-installer install, even when
 * their `bin` is not on `PATH` (issue #76). Exported so the consent prompt lists
 * them (roadmap S2). No installer-managed location is listed because detection
 * reads none.
 */
export const EXTERNAL_PREFIXES = ['.local', '.npm-global'] as const;

/**
 * The non-installer layout this adapter looks for. The binary and Homebrew
 * formula names are the runtime's published distribution names; the npm package
 * name is deliberately omitted (see the module comment).
 */
const EXTERNAL_INSTALL: ExternalInstallSpec = {
  binary: 'opencode',
  homebrewFormulae: ['opencode'],
  knownPrefixes: EXTERNAL_PREFIXES,
};

const RUNTIME_ID = runtimeId('opencode');

export async function detectOpencode(
  home: string = homedir(),
  pathValue: string = process.env['PATH'] ?? '',
): Promise<RuntimeDetection> {
  const external = await readExternalInstall(home, pathValue, EXTERNAL_INSTALL);
  const { version, diagnostic: disagreement } = reconcileVersionSources(external.versions);
  const installed = version !== null || external.present;

  const diagnostics: Diagnostic[] = [];
  if (disagreement !== null) diagnostics.push(disagreement);
  if (!installed) {
    diagnostics.push({
      severity: 'info',
      code: 'runtime-not-found',
      message: 'no OpenCode installation was found on disk',
    });
  } else if (version === null) {
    diagnostics.push({
      severity: 'info',
      code: 'runtime-version-unknown',
      message: 'the OpenCode version could not be determined from disk',
    });
  } else {
    const position = versionSetPosition(version, VERIFIED_OPENCODE_SET);
    if (position === 'below') {
      diagnostics.push({
        severity: 'warning',
        code: 'runtime-version-below-verified',
        message: `OpenCode ${version} is below the verified versions ${VERIFIED_OPENCODE_VERSIONS.join(', ')}`,
      });
    } else if (position === 'above' || position === 'unknown') {
      diagnostics.push({
        severity: 'warning',
        code: 'runtime-version-unverified',
        message: `OpenCode ${version} is not one of the verified versions ${VERIFIED_OPENCODE_VERSIONS.join(', ')}`,
      });
    }
  }

  return {
    runtimeId: RUNTIME_ID,
    installed: installed ? 'yes' : 'no',
    version,
    runtimeCompatibility: isVersionInSet(version, VERIFIED_OPENCODE_SET)
      ? 'verified'
      : 'unverified',
    diagnostics,
  };
}
