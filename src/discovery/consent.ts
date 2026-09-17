import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { EXIT_CODES, PflError } from '../cli/exit-codes.js';
import type { RuntimeId } from '../core/ids.js';
import type { AccessPolicy } from '../runtime/types.js';
import { checkSymlinkAncestors } from '../util/fs.js';
import { permissionsPath } from '../snapshot/store.js';

/**
 * Consent boundary (design doc §19, §24). Project-local discovery is
 * implicit; reading outside the project requires explicit consent, stored per
 * runtime + scope, so granting user-scope access for `claude-code` grants
 * nothing for `codex`.
 *
 * A grant already on disk is honored regardless of interactivity, so a
 * non-interactive run (`--json`, no TTY) can proceed on consent the user
 * recorded earlier. Only a *missing* grant fails closed: a non-interactive run
 * throws `CONSENT_REQUIRED` rather than assuming consent.
 */

/** A stable key for one runtime + scope grant. */
export function consentScopeKey(runtimeId: RuntimeId, scope: string): string {
  return `${runtimeId}:${scope}`;
}

export interface ConsentStore {
  /** Granted scope keys, each produced by `consentScopeKey`. */
  grantedScopes: string[];
}

export async function loadConsentStore(home: string = homedir()): Promise<ConsentStore> {
  // `~/.pfl` and `permissions.json` are pfl's own store: a symlink at either is
  // refused rather than followed, so a redirected store is not read from or
  // written to (S10).
  if ((await checkSymlinkAncestors(home, permissionsPath(home))) !== 'ok') {
    return { grantedScopes: [] };
  }
  const text = await readFile(permissionsPath(home), 'utf8').catch(() => null);
  if (text === null) return { grantedScopes: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { grantedScopes: [] };
  }
  const granted = (parsed as { grantedScopes?: unknown }).grantedScopes;
  if (!Array.isArray(granted)) return { grantedScopes: [] };
  return { grantedScopes: granted.filter((value): value is string => typeof value === 'string') };
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Records a grant, writing `~/.pfl/permissions.json` the way the snapshot
 * store writes its artifacts (roadmap S10): the directory and file modes are
 * re-asserted rather than trusted to `umask`, and the temp file is cleaned up
 * in a `finally` even when the rename fails. That the file is tamperable by
 * anything running as the same user is an accepted risk (A2).
 */
export async function grantConsent(scopeKey: string, home: string = homedir()): Promise<void> {
  const store = await loadConsentStore(home);
  if (!store.grantedScopes.includes(scopeKey)) {
    store.grantedScopes.push(scopeKey);
  }
  const target = permissionsPath(home);
  if ((await checkSymlinkAncestors(home, target)) !== 'ok') {
    throw new PflError(
      'the consent store path is a symlink and was not written',
      EXIT_CODES.SNAPSHOT_STORE_FAILED,
    );
  }
  const dir = dirname(target);
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await chmod(dir, DIR_MODE);
    await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: FILE_MODE });
    await chmod(temp, FILE_MODE);
    await rename(temp, target);
    await chmod(target, FILE_MODE);
  } catch (error) {
    throw new PflError(
      `could not write the consent store: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_CODES.SNAPSHOT_STORE_FAILED,
    );
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

export function hasConsent(store: ConsentStore, runtimeId: RuntimeId, scope: string): boolean {
  return store.grantedScopes.includes(consentScopeKey(runtimeId, scope));
}

/**
 * Whether any runtime has been granted its user scope. Read commands are
 * runtime-agnostic (a project id is shared across runtimes), so they use this
 * to decide whether out-of-project Git metadata may be read (roadmap S5). M8's
 * scope taxonomy replaces this approximation.
 */
export async function hasAnyUserConsent(home: string = homedir()): Promise<boolean> {
  const store = await loadConsentStore(home);
  return store.grantedScopes.some((scope) => scope.endsWith(':user'));
}

/** A titled group of locations, rendered in the §24 prompt. */
export interface ConsentLocationGroup {
  title: string;
  locations: readonly string[];
}

export interface ConsentRequest {
  runtimeId: RuntimeId;
  /** Display name used in the prompt, e.g. `Claude Code`. */
  runtimeName: string;
  /** Scope being requested, e.g. `user`. */
  scope: string;
  groups: readonly ConsentLocationGroup[];
}

/** Reads one answer; injected in tests so no TTY is needed. */
export interface ConsentIO {
  readAnswer(prompt: string): Promise<string>;
}

export interface ConsentOptions {
  home?: string;
  /** Whether an interactive prompt is possible. False means fail closed. */
  interactive: boolean;
  io?: ConsentIO;
  /**
   * Scope keys granted for this run only (the `--allow-scope` flag). They are
   * honored without prompting and are never written to the consent store.
   */
  currentRunGrants?: readonly string[];
  /**
   * Whether a missing grant is fatal for the caller. `user` is required to
   * discover the harness; `install` is optional (its absence yields the
   * `unknown` detection state, roadmap #81). Defaults to `true`.
   */
  required?: boolean;
}

export function accessPolicy(
  grantedScopes: readonly string[],
  runtimeId: RuntimeId,
  currentRunGrants: readonly string[] = [],
): AccessPolicy {
  const scopes = new Set([...grantedScopes, ...currentRunGrants]);
  return {
    user: scopes.has(consentScopeKey(runtimeId, 'user')),
    install: scopes.has(consentScopeKey(runtimeId, 'install')),
    grantedScopes: [...scopes],
  };
}

/**
 * Resolves the AccessPolicy for one runtime + scope. An existing grant — or a
 * current-run `--allow-scope` key — returns immediately, before any
 * interactivity check, so a non-interactive run can proceed on consent it was
 * given. With no grant, an interactive run prompts once and an answer other
 * than `y`/`yes` (including the empty default) leaves the policy closed; a
 * non-interactive run throws `CONSENT_REQUIRED` when the scope is required and
 * returns a closed policy when it is not.
 */
export async function resolveAccessPolicy(
  request: ConsentRequest,
  options: ConsentOptions,
): Promise<AccessPolicy> {
  const home = options.home ?? homedir();
  const currentRunGrants = options.currentRunGrants ?? [];
  const key = consentScopeKey(request.runtimeId, request.scope);
  const store = await loadConsentStore(home);
  if (store.grantedScopes.includes(key) || currentRunGrants.includes(key)) {
    return accessPolicy(store.grantedScopes, request.runtimeId, currentRunGrants);
  }

  if (!options.interactive) {
    if (options.required === false) {
      return accessPolicy(store.grantedScopes, request.runtimeId, currentRunGrants);
    }
    throw new PflError(
      `reading outside the project requires consent for ${key}; rerun interactively or pass --allow-scope ${key}`,
      EXIT_CODES.CONSENT_REQUIRED,
      { missingScopes: [key] },
    );
  }

  const io = options.io ?? createNodeConsentIO();
  const answer = (await io.readAnswer(renderConsentPrompt(request))).trim();
  if (!/^y(es)?$/i.test(answer)) {
    return accessPolicy(store.grantedScopes, request.runtimeId, currentRunGrants);
  }

  await grantConsent(key, home);
  const granted = await loadConsentStore(home);
  return accessPolicy(granted.grantedScopes, request.runtimeId, currentRunGrants);
}

/** Renders the §24 prompt verbatim; the caller's answer is read on the last line. */
export function renderConsentPrompt(request: ConsentRequest): string {
  const lines: string[] = ['Inventory needs read-only access to the following locations:', ''];
  for (const group of request.groups) {
    lines.push(`  ${group.title}`);
    for (const location of group.locations) {
      lines.push(`    ${location}`);
    }
    lines.push('');
  }
  lines.push(
    '  (Project-local discovery is implicit and needs no consent.)',
    '',
    'Inventory will:',
    '  ✓ Read files needed to resolve the effective harness',
    '  ✓ Check the installed runtime version',
    '  ✓ Process content locally',
    '  ✓ Store only digests and allowlisted metadata',
    '  ✗ Store file contents',
    '  ✗ Store environment values or credentials',
    `  ✗ Execute ${request.runtimeName} or any discovered tool`,
    '  ✗ Follow symlinks inside the listed locations',
    '',
    'Allow this runtime scope? [y/N] ',
  );
  return lines.join('\n');
}

function createNodeConsentIO(): ConsentIO {
  return {
    async readAnswer(prompt: string): Promise<string> {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    },
  };
}
