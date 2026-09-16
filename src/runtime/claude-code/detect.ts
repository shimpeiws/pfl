import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Diagnostic } from '../../core/diagnostics.js';
import { runtimeId } from '../../core/ids.js';
import { MAX_PARSE_BYTES } from '../../limits.js';
import { pathExists, readDirectoryNames, readTextFileGuarded } from '../../util/fs.js';
import type { RuntimeDetection } from '../types.js';
import {
  formatVersion,
  highestVersion,
  isWithinRange,
  parseVersion,
  type VersionRange,
} from '../version-compat.js';

/**
 * Static runtime detection for Claude Code (design doc §8, §17). Reads version
 * metadata from disk; it never spawns the runtime or runs `claude --version`.
 *
 * Version sources, in order:
 *   1. `~/.claude/.last-update-result.json` (`version_to`) — installation
 *      metadata, not harness content.
 *   2. the highest `~/.local/share/claude/versions/<version>` entry.
 *
 * `installed` is true only when an installation location exists — a bare
 * `~/.claude` config directory is not evidence that the runtime is installed.
 *
 * The verified range is provisional data until M2 pins Claude Code's
 * resolution semantics (issue #8).
 */
export const VERIFIED_CLAUDE_CODE_RANGE: VersionRange = { min: '2.1.0', max: '2.2.0' };

const RUNTIME_ID = runtimeId('claude-code');

export async function detectClaudeCode(home: string = homedir()): Promise<RuntimeDetection> {
  const version = await readClaudeCodeVersion(home);
  const installed = version !== null || (await claudeCodeIsPresent(home));

  const diagnostics: Diagnostic[] = [];
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
  } else if (!isWithinRange(version, VERIFIED_CLAUDE_CODE_RANGE)) {
    diagnostics.push({
      severity: 'warning',
      code: 'runtime-version-unverified',
      message: `Claude Code ${version} is outside the verified adapter range ${VERIFIED_CLAUDE_CODE_RANGE.min}..${VERIFIED_CLAUDE_CODE_RANGE.max}`,
    });
  }

  return {
    runtimeId: RUNTIME_ID,
    installed,
    version,
    runtimeCompatibility:
      version !== null && isWithinRange(version, VERIFIED_CLAUDE_CODE_RANGE)
        ? 'verified'
        : 'unverified',
    diagnostics,
  };
}

async function claudeCodeIsPresent(home: string): Promise<boolean> {
  const installations = [
    join(home, '.local', 'share', 'claude'),
    join(home, '.local', 'bin', 'claude'),
  ];
  const found = await Promise.all(installations.map((location) => pathExists(location)));
  return found.some(Boolean);
}

async function readClaudeCodeVersion(home: string): Promise<string | null> {
  const fromUpdate = await readUpdateResultVersion(
    join(home, '.claude', '.last-update-result.json'),
  );
  if (fromUpdate !== null) return fromUpdate;

  const versions = await readDirectoryNames(join(home, '.local', 'share', 'claude', 'versions'));
  return highestVersion(versions);
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
