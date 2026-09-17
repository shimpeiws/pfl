import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Diagnostic } from '../../core/diagnostics.js';
import { runtimeId } from '../../core/ids.js';
import { MAX_PARSE_BYTES } from '../../limits.js';
import { pathExists, readDirectoryNames, readTextFileGuarded } from '../../util/fs.js';
import { readExternalInstall, type ExternalInstallSpec } from '../external-install.js';
import type { RuntimeDetection } from '../types.js';
import {
  formatVersion,
  highestVersion,
  parseVersion,
  versionPosition,
  type VersionRange,
} from '../version-compat.js';
import { reconcileVersionSources, type VersionSource } from '../version-sources.js';

/**
 * Static runtime detection for Claude Code (design doc §8, §17). Reads version
 * metadata from disk; it never spawns the runtime or runs `claude --version`.
 *
 * Installer-managed version sources, in order:
 *   1. `~/.claude/.last-update-result.json` (`version_to`) — installation
 *      metadata, not harness content.
 *   2. the highest `~/.local/share/claude/versions/<version>` entry.
 *
 * A runtime the installer does not manage — npm global, Homebrew, or a bare
 * `claude` on `PATH` — is found too (issue #76): the binary is detected by name
 * in a bin directory, never resolved, and a version is read from an npm
 * `package.json` or a Homebrew `Cellar` version directory when one is present.
 * When two sources disagree, the highest parseable version is used and a
 * diagnostic names both rather than one being chosen silently.
 *
 * `installed` distinguishes "found" (`yes`) from "looked and found nothing"
 * (`no`) and "could not look" (`unknown`, decided by the adapter's consent gate).
 * A bare `~/.claude` config directory is not evidence that the runtime is
 * installed.
 *
 * The verified range is provisional data until M2 pins Claude Code's
 * resolution semantics (issue #8).
 */
export const VERIFIED_CLAUDE_CODE_RANGE: VersionRange = { min: '2.1.0', max: '2.2.0' };

/**
 * Installation and version-metadata locations, relative to the home directory.
 * Exported so the consent prompt lists exactly what detection reads (roadmap
 * S2) rather than a hand-maintained subset.
 */
export const INSTALL_LOCATIONS = ['.local/share/claude', '.local/bin/claude'] as const;
export const VERSIONS_DIR = '.local/share/claude/versions';
export const UPDATE_RESULT_FILE = '.claude/.last-update-result.json';

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
  binary: 'claude',
  npmPackage: '@anthropic-ai/claude-code',
  homebrewFormulae: ['claude-code'],
  knownPrefixes: EXTERNAL_PREFIXES,
};

const RUNTIME_ID = runtimeId('claude-code');

export async function detectClaudeCode(
  home: string = homedir(),
  pathValue: string = process.env['PATH'] ?? '',
): Promise<RuntimeDetection> {
  const external = await readExternalInstall(home, pathValue, EXTERNAL_INSTALL);
  const sources = [...(await installerVersionSources(home)), ...external.versions];
  const { version, diagnostic: disagreement } = reconcileVersionSources(sources);
  const installed = version !== null || external.present || (await claudeCodeIsPresent(home));

  const diagnostics: Diagnostic[] = [];
  if (disagreement !== null) diagnostics.push(disagreement);
  if (!installed) {
    diagnostics.push({
      severity: 'info',
      code: 'runtime-not-found',
      message: 'no Claude Code installation was found on disk',
    });
  } else if (version === null) {
    diagnostics.push({
      severity: 'info',
      code: 'runtime-version-unknown',
      message: 'the Claude Code version could not be determined from disk',
    });
  } else {
    const position = versionPosition(version, VERIFIED_CLAUDE_CODE_RANGE);
    if (position === 'below') {
      diagnostics.push({
        severity: 'warning',
        code: 'runtime-version-below-verified',
        message: `Claude Code ${version} is below the verified adapter range ${VERIFIED_CLAUDE_CODE_RANGE.min}..${VERIFIED_CLAUDE_CODE_RANGE.max}`,
      });
    } else if (position === 'above') {
      diagnostics.push({
        severity: 'warning',
        code: 'runtime-version-unverified',
        message: `Claude Code ${version} is above the verified adapter range ${VERIFIED_CLAUDE_CODE_RANGE.min}..${VERIFIED_CLAUDE_CODE_RANGE.max}`,
      });
    }
  }

  return {
    runtimeId: RUNTIME_ID,
    installed: installed ? 'yes' : 'no',
    version,
    runtimeCompatibility:
      version !== null && versionPosition(version, VERIFIED_CLAUDE_CODE_RANGE) === 'within'
        ? 'verified'
        : 'unverified',
    diagnostics,
  };
}

async function installerVersionSources(home: string): Promise<VersionSource[]> {
  const sources: VersionSource[] = [];
  const fromUpdate = await readUpdateResultVersion(join(home, UPDATE_RESULT_FILE));
  if (fromUpdate !== null) {
    sources.push({ label: 'installer update metadata', version: fromUpdate });
  }
  const versions = await readDirectoryNames(home, join(home, VERSIONS_DIR));
  const fromVersions = highestVersion(versions);
  if (fromVersions !== null) {
    sources.push({ label: 'installer versions directory', version: fromVersions });
  }
  return sources;
}

async function claudeCodeIsPresent(home: string): Promise<boolean> {
  const found = await Promise.all(
    INSTALL_LOCATIONS.map((location) => pathExists(home, join(home, location))),
  );
  return found.some(Boolean);
}

async function readUpdateResultVersion(path: string): Promise<string | null> {
  // Leaf-only guard: the file must not be a symlink, and a FIFO must not hang.
  const read = await readTextFileGuarded(path, MAX_PARSE_BYTES, dirname(path));
  if (read.status !== 'ok') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return null;
  }
  const candidate = (parsed as { version_to?: unknown }).version_to;
  if (typeof candidate !== 'string') return null;
  const version = parseVersion(candidate);
  return version === null ? null : formatVersion(version);
}
