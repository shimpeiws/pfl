import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Diagnostic } from '../../core/diagnostics.js';
import { runtimeId } from '../../core/ids.js';
import { pathExists, readDirectoryNames } from '../../util/fs.js';
import { readExternalInstall, type ExternalInstallSpec } from '../external-install.js';
import type { RuntimeDetection } from '../types.js';
import { highestVersion, versionPosition, type VersionRange } from '../version-compat.js';
import { reconcileVersionSources, type VersionSource } from '../version-sources.js';
import { userConfigDir } from './paths.js';

/**
 * Static runtime detection for Codex (design doc §8, §17). Reads version
 * metadata from disk; it never spawns the runtime or runs `codex --version`.
 *
 * Installer-managed version source: the highest
 * `~/.codex/packages/standalone/releases/<version>-<target>` entry. The release
 * directory name carries the version, so no symlink (the `current` symlink) is
 * followed.
 *
 * A runtime the installer does not manage — npm global, Homebrew, or a bare
 * `codex` on `PATH` — is found too (issue #76): the binary is detected by name
 * in a bin directory, never resolved, and a version is read from an npm
 * `package.json` or a Homebrew `Cellar` version directory when one is present.
 * This is what catches a stale release directory beside a newer CLI: when two
 * sources disagree, the highest parseable version is used and a diagnostic names
 * both rather than one being chosen silently.
 *
 * `installed` distinguishes "found" (`yes`) from "looked and found nothing"
 * (`no`) and "could not look" (`unknown`, decided by the adapter's consent gate).
 * A bare `~/.codex` config directory is not evidence that the runtime is
 * installed.
 *
 * The verified range is provisional data until M2 pins Codex's resolution
 * semantics (issue #8).
 */
export const VERIFIED_CODEX_RANGE: VersionRange = { min: '0.150.0', max: '0.155.0' };

/**
 * Installation locations, relative to the home directory. Exported so the
 * consent prompt lists exactly what detection reads (roadmap S2).
 */
export const INSTALL_LOCATIONS = [
  '.codex/packages/standalone/releases',
  '.codex/packages/standalone',
] as const;

/**
 * Fixed home-relative prefixes checked for a non-installer install, even when
 * their `bin` is not on `PATH` (issue #76). Exported so the consent prompt lists
 * them (roadmap S2).
 */
export const EXTERNAL_PREFIXES = ['.local', '.npm-global'] as const;

/**
 * The non-installer layout this adapter looks for (issue #76). The binary name
 * and package/formula names are the runtime's published distribution names; the
 * fixed prefixes cover a home install whose `bin` is not on `PATH`.
 */
const EXTERNAL_INSTALL: ExternalInstallSpec = {
  binary: 'codex',
  npmPackage: '@openai/codex',
  homebrewFormulae: ['codex'],
  knownPrefixes: EXTERNAL_PREFIXES,
};

const RUNTIME_ID = runtimeId('codex');

export async function detectCodex(
  home: string = homedir(),
  pathValue: string = process.env['PATH'] ?? '',
): Promise<RuntimeDetection> {
  const external = await readExternalInstall(home, pathValue, EXTERNAL_INSTALL);
  const releaseNames = await readDirectoryNames(userConfigDir(home), codexReleasesDir(home));
  const fromReleases = highestVersion(releaseNames);
  const sources: VersionSource[] = [
    ...(fromReleases !== null
      ? [{ label: 'installer releases directory', version: fromReleases }]
      : []),
    ...external.versions,
  ];
  const { version, diagnostic: disagreement } = reconcileVersionSources(sources);
  const installed = version !== null || external.present || (await codexIsPresent(home));

  const diagnostics: Diagnostic[] = [];
  if (disagreement !== null) diagnostics.push(disagreement);
  if (!installed) {
    diagnostics.push({
      severity: 'info',
      code: 'runtime-not-found',
      message: 'no Codex installation was found on disk',
    });
  } else if (version === null) {
    diagnostics.push({
      severity: 'info',
      code: 'runtime-version-unknown',
      message: 'the Codex version could not be determined from disk',
    });
  } else {
    const position = versionPosition(version, VERIFIED_CODEX_RANGE);
    if (position === 'below') {
      diagnostics.push({
        severity: 'warning',
        code: 'runtime-version-below-verified',
        message: `Codex ${version} is below the verified adapter range ${VERIFIED_CODEX_RANGE.min}..${VERIFIED_CODEX_RANGE.max}`,
      });
    } else if (position === 'above') {
      diagnostics.push({
        severity: 'warning',
        code: 'runtime-version-unverified',
        message: `Codex ${version} is above the verified adapter range ${VERIFIED_CODEX_RANGE.min}..${VERIFIED_CODEX_RANGE.max}`,
      });
    }
  }

  return {
    runtimeId: RUNTIME_ID,
    installed: installed ? 'yes' : 'no',
    version,
    runtimeCompatibility:
      version !== null && versionPosition(version, VERIFIED_CODEX_RANGE) === 'within'
        ? 'verified'
        : 'unverified',
    diagnostics,
  };
}

function codexReleasesDir(home: string): string {
  return join(home, INSTALL_LOCATIONS[0]);
}

async function codexIsPresent(home: string): Promise<boolean> {
  const found = await Promise.all(
    INSTALL_LOCATIONS.map((location) => pathExists(userConfigDir(home), join(home, location))),
  );
  return found.some(Boolean);
}
