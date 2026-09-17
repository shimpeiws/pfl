import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { MAX_PARSE_BYTES } from '../limits.js';
import { readDirectoryNames, readTextFileGuarded } from '../util/fs.js';
import { formatVersion, highestVersion, parseVersion } from './version-compat.js';
import type { VersionSource } from './version-sources.js';

/**
 * Detection of installs the runtime's own installer does not manage (design doc
 * §17, roadmap §5 M7, issue #76): npm global, Homebrew, and PATH-only. A binary
 * is detected by its name in a directory's entries, so a symlinked launcher
 * (`~/.local/bin/claude -> ...`) is seen without ever being resolved; a version
 * is read only from a regular `package.json` or a version-shaped directory name.
 * Nothing is executed and no symlink is followed.
 *
 * Every read here is out-of-project and runs only behind the install consent
 * gate; the caller passes the already-consented home and `PATH`.
 */

export interface ExternalInstall {
  /** Whether a binary with the requested name was found in a checked directory. */
  present: boolean;
  /** Versions read from npm and Homebrew layouts, labeled for a safe diagnostic. */
  versions: VersionSource[];
}

export interface ExternalInstallSpec {
  /** Binary name as it appears in a bin directory (`claude`, `codex`). */
  binary: string;
  /** npm package name under `<prefix>/lib/node_modules` (`@scope/name`). */
  npmPackage: string;
  /** Homebrew formula names under `<prefix>/Cellar`. */
  homebrewFormulae: readonly string[];
  /**
   * Fixed home-relative prefixes checked even when their `bin` is not on PATH.
   * Homebrew and npm prefixes on PATH are derived from the `bin` entries.
   */
  knownPrefixes: readonly string[];
}

const NPM_LABEL = 'npm global package';
const HOMEBREW_LABEL = 'Homebrew Cellar';

/**
 * Base for the ancestor guard on PATH-derived reads. A PATH entry has no scope
 * root the way a harness read does, so every component from the filesystem root
 * to the target is checked and a symlink anywhere refuses the read.
 */
const FILESYSTEM_ROOT = '/';

export async function readExternalInstall(
  home: string,
  pathValue: string,
  spec: ExternalInstallSpec,
): Promise<ExternalInstall> {
  const binDirs = new Set<string>();
  const prefixes = new Set<string>();
  for (const relative of spec.knownPrefixes) {
    const prefix = join(home, relative);
    prefixes.add(prefix);
    binDirs.add(join(prefix, 'bin'));
  }
  for (const entry of pathValue.split(delimiter)) {
    if (entry === '' || !isAbsolute(entry)) continue;
    binDirs.add(entry);
    if (basename(entry) === 'bin') prefixes.add(dirname(entry));
  }

  let present = false;
  for (const dir of binDirs) {
    // A directory listing, not a probe of the binary. Every component from the
    // filesystem root is checked and any symlink refuses the read, so a symlinked
    // launcher is still counted as present (the leaf entry is not followed; the
    // listing only shows its name), while a symlinked PATH entry or a symlinked
    // ancestor is skipped rather than traversed. `FILESYSTEM_ROOT` is the base
    // because a PATH entry is not under a scope root the way a harness read is.
    const names = await readDirectoryNames(FILESYSTEM_ROOT, dir);
    if (names.includes(spec.binary)) present = true;
  }

  const versions: VersionSource[] = [];
  for (const prefix of prefixes) {
    const npmVersion = await readNpmVersion(prefix, spec.npmPackage);
    if (npmVersion !== null) versions.push({ label: NPM_LABEL, version: npmVersion });
    const homebrewVersion = await readHomebrewVersion(prefix, spec.homebrewFormulae);
    if (homebrewVersion !== null) {
      versions.push({ label: HOMEBREW_LABEL, version: homebrewVersion });
    }
  }

  return { present, versions };
}

async function readNpmVersion(prefix: string, npmPackage: string): Promise<string | null> {
  const manifest = join(prefix, 'lib', 'node_modules', ...npmPackage.split('/'), 'package.json');
  const read = await readTextFileGuarded(manifest, MAX_PARSE_BYTES, FILESYSTEM_ROOT);
  if (read.status !== 'ok') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return null;
  }
  const candidate = (parsed as { version?: unknown }).version;
  if (typeof candidate !== 'string') return null;
  const version = parseVersion(candidate);
  return version === null ? null : formatVersion(version);
}

async function readHomebrewVersion(
  prefix: string,
  formulae: readonly string[],
): Promise<string | null> {
  const cellar = await readDirectoryNames(FILESYSTEM_ROOT, join(prefix, 'Cellar'));
  const candidates: string[] = [];
  for (const formula of formulae) {
    if (!cellar.includes(formula)) continue;
    const versions = await readDirectoryNames(FILESYSTEM_ROOT, join(prefix, 'Cellar', formula));
    candidates.push(...versions);
  }
  return highestVersion(candidates);
}
