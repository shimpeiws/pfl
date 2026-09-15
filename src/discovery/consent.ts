import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { EXIT_CODES, PflError } from '../cli/exit-codes.js';
import type { RuntimeId } from '../core/ids.js';
import type { AccessPolicy } from '../runtime/types.js';
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

export async function grantConsent(scopeKey: string, home: string = homedir()): Promise<void> {
  const store = await loadConsentStore(home);
  if (!store.grantedScopes.includes(scopeKey)) {
    store.grantedScopes.push(scopeKey);
  }
  const target = permissionsPath(home);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, target);
}

export function hasConsent(store: ConsentStore, runtimeId: RuntimeId, scope: string): boolean {
  return store.grantedScopes.includes(consentScopeKey(runtimeId, scope));
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
}

/**
 * Resolves the AccessPolicy for one runtime + scope. An existing grant returns
 * immediately, before any interactivity check, so a non-interactive run can
 * reuse recorded consent. With no grant, an interactive run prompts once and an
 * answer other than `y`/`yes` (including the empty default) leaves the policy
 * closed; a non-interactive run throws `CONSENT_REQUIRED`.
 */
export async function resolveAccessPolicy(
  request: ConsentRequest,
  options: ConsentOptions,
): Promise<AccessPolicy> {
  const home = options.home ?? homedir();
  const store = await loadConsentStore(home);
  if (hasConsent(store, request.runtimeId, request.scope)) {
    return { allowOutsideProject: true, grantedScopes: store.grantedScopes };
  }

  if (!options.interactive) {
    throw new PflError(
      `reading outside the project requires consent for ${consentScopeKey(request.runtimeId, request.scope)}; rerun interactively to grant it`,
      EXIT_CODES.CONSENT_REQUIRED,
    );
  }

  const io = options.io ?? createNodeConsentIO();
  const answer = (await io.readAnswer(renderConsentPrompt(request))).trim();
  if (!/^y(es)?$/i.test(answer)) {
    return { allowOutsideProject: false, grantedScopes: store.grantedScopes };
  }

  await grantConsent(consentScopeKey(request.runtimeId, request.scope), home);
  const granted = await loadConsentStore(home);
  return { allowOutsideProject: true, grantedScopes: granted.grantedScopes };
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
    'Inventory will:',
    '  ✓ Read files needed to resolve the effective harness',
    '  ✓ Check the installed runtime version',
    '  ✓ Process content locally',
    '  ✓ Store only digests and allowlisted metadata',
    '  ✗ Store file contents',
    '  ✗ Store environment values or credentials',
    `  ✗ Execute ${request.runtimeName} or any discovered tool`,
    '  ✗ Follow symlinks',
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
