import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Diagnostic } from '../../core/diagnostics.js';
import { runtimeId } from '../../core/ids.js';
import { pathExists, readDirectoryNames } from '../../util/fs.js';
import type { RuntimeDetection } from '../types.js';
import { highestVersion, isWithinRange, type VersionRange } from '../version-compat.js';
import { userConfigDir } from './paths.js';

/**
 * Static runtime detection for Codex (design doc §8, §17). Reads version
 * metadata from disk; it never spawns the runtime or runs `codex --version`.
 *
 * Version source: the highest `~/.codex/packages/standalone/releases/<version>-<target>`
 * entry. The release directory name carries the version, so no symlink (the
 * `current` symlink) is followed.
 *
 * `installed` is true only when an installation location exists — a bare
 * `~/.codex` config directory is not evidence that the runtime is installed.
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

const RUNTIME_ID = runtimeId('codex');

export async function detectCodex(home: string = homedir()): Promise<RuntimeDetection> {
  const releaseNames = await readDirectoryNames(userConfigDir(home), codexReleasesDir(home));
  const version = highestVersion(releaseNames);
  const installed = version !== null || (await codexIsPresent(home));

  const diagnostics: Diagnostic[] = [];
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
  } else if (!isWithinRange(version, VERIFIED_CODEX_RANGE)) {
    diagnostics.push({
      severity: 'warning',
      code: 'runtime-version-unverified',
      message: `Codex ${version} is outside the verified adapter range ${VERIFIED_CODEX_RANGE.min}..${VERIFIED_CODEX_RANGE.max}`,
    });
  }

  return {
    runtimeId: RUNTIME_ID,
    installed,
    version,
    runtimeCompatibility:
      version !== null && isWithinRange(version, VERIFIED_CODEX_RANGE) ? 'verified' : 'unverified',
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
