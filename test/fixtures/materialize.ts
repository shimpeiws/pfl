import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Materializes a synthetic harness into an isolated temp directory. The
 * committed fixture trees hold regular files only; the pieces git cannot store —
 * a symlink that escapes the project and a mode-000 unreadable file — are
 * created here, so every test runs against a hermetic, disposable tree.
 */

const fixturesRoot = dirname(fileURLToPath(import.meta.url));

export type FixtureRuntime = 'claude' | 'codex';

export const RUNTIME_IDS: Record<FixtureRuntime, string> = {
  claude: 'claude-code',
  codex: 'codex',
};

/** Sentinel strings so a leak of raw content into a persisted artifact is greppable. */
export const SENTINELS = [
  'SENTINEL_CLAUDE_PROJECT',
  'SENTINEL_CLAUDE_NESTED',
  'SENTINEL_CLAUDE_SKILL',
  'SENTINEL_CLAUDE_BROKEN',
  'SENTINEL_CLAUDE_UNKNOWN',
  'SENTINEL_CLAUDE_USER',
  'SENTINEL_CLAUDE_MEMORY',
  'SENTINEL_CLAUDE_SETTINGS',
  'SENTINEL_CODEX_PROJECT',
  'SENTINEL_CODEX_OVERRIDE',
  'SENTINEL_CODEX_USER',
  'SENTINEL_CODEX_BROKEN',
  'SENTINEL_CODEX_MEMORY',
  'SENTINEL_CODEX_HOOKS',
  'SENTINEL_LEAKED',
] as const;

/** Secret-shaped values planted in the fixtures; none may reach disk. */
export const SECRETS = [
  'sk-ant-api03-EXFILTRATION-0123456789',
  'alice:s3cr3t-p4ss@example.com',
  'wJalrXUtnFEMIEXAMPLEKEY0123456789',
  'ghp_0123456789abcdefghijklmnopqrstuvwx',
  'MIIEXFILTRATIONEXAMPLEKEYMATERIAL',
] as const;

export interface Materialized {
  base: string;
  projectRoot: string;
  home: string;
  outsideDir: string;
  symlinkPath: string;
  /** The display path the snapshot uses for the symlink. */
  symlinkRelativePath: string;
  /** A regular file replaced by a symlink into `outside`, at a settings-read path. */
  settingsSymlinkPath: string;
  /** The display path the snapshot uses for the settings symlink (S1). */
  settingsSymlinkRelativePath: string;
  unreadablePath: string;
  runtime: FixtureRuntime;
}

export async function materialize(runtime: FixtureRuntime): Promise<Materialized> {
  const base = await mkdtemp(join(tmpdir(), `pfl-fixture-${runtime}-`));
  const projectRoot = join(base, 'project');
  const home = join(base, 'home');
  await cp(join(fixturesRoot, runtime, 'project'), projectRoot, { recursive: true });
  await cp(join(fixturesRoot, runtime, 'home'), home, { recursive: true });

  const outsideDir = join(base, 'outside');
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, 'leaked.txt'), 'SENTINEL_LEAKED\n');

  const symlinkPath =
    runtime === 'claude'
      ? join(projectRoot, '.claude', 'link')
      : join(home, '.codex', 'skills', 'link');
  await symlink(outsideDir, symlinkPath);

  // S1: a symlink at a settings-read path. For Claude Code this is project scope
  // (no consent needed) and must never be followed; for Codex it replaces the
  // committed hooks.json, since the adapter reads the user scope under consent.
  const settingsSecret =
    runtime === 'claude'
      ? JSON.stringify({
          permissions: { allow: ['Bash(curl SENTINEL_CLAUDE_SETTINGS)'] },
          token: 'sk-ant-settings-symlink-secret',
        })
      : JSON.stringify({ hooks: { SessionStart: [{ matcher: 'SENTINEL_CODEX_HOOKS' }] } });
  await writeFile(join(outsideDir, 'settings-secret.json'), settingsSecret);

  const settingsSymlinkPath =
    runtime === 'claude'
      ? join(projectRoot, '.claude', 'settings.local.json')
      : join(home, '.codex', 'hooks.json');
  if (runtime === 'codex') await rm(settingsSymlinkPath, { force: true });
  await symlink(join(outsideDir, 'settings-secret.json'), settingsSymlinkPath);

  const unreadablePath =
    runtime === 'claude'
      ? join(projectRoot, '.claude', 'skills', 'broken', 'SKILL.md')
      : join(home, '.codex', 'skills', 'broken.md');
  await chmod(unreadablePath, 0o000);

  return {
    base,
    projectRoot,
    home,
    outsideDir,
    symlinkPath,
    symlinkRelativePath: runtime === 'claude' ? '.claude/link' : '~/.codex/skills/link',
    settingsSymlinkPath,
    settingsSymlinkRelativePath:
      runtime === 'claude' ? '.claude/settings.local.json' : '~/.codex/hooks.json',
    unreadablePath,
    runtime,
  };
}

/** Pre-grants user-scope consent so a run needs no interactive prompt. */
export async function grantConsent(home: string, runtime: FixtureRuntime): Promise<void> {
  await mkdir(join(home, '.pfl'), { recursive: true });
  await writeFile(
    join(home, '.pfl', 'permissions.json'),
    JSON.stringify({ grantedScopes: [`${RUNTIME_IDS[runtime]}:user`] }),
  );
}

export interface FileFingerprint {
  hash: string;
  mtimeMs: number;
}

/** Content hash and mtime for every regular file under `dir` (symlinks skipped). */
export async function fingerprintTree(dir: string): Promise<Map<string, FileFingerprint>> {
  const fingerprints = new Map<string, FileFingerprint>();
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const [content, stats] = await Promise.all([
          readFile(full).catch(() => Buffer.from('')),
          stat(full),
        ]);
        fingerprints.set(relative(dir, full), {
          hash: createHash('sha256').update(content).digest('hex'),
          mtimeMs: stats.mtimeMs,
        });
      }
    }
  }
  await walk(dir);
  return fingerprints;
}

/** Concatenated text of every artifact the store wrote under `home/.pfl`. */
export async function readStoreArtifacts(home: string): Promise<string> {
  const root = join(home, '.pfl');
  const chunks: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) chunks.push(await readFile(full, 'utf8').catch(() => ''));
    }
  }
  await walk(root);
  return chunks.join('\n');
}
