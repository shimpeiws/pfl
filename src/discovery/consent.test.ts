import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_CODES, PflError } from '../cli/exit-codes.js';
import { runtimeId } from '../core/ids.js';
import { getConsentRequest } from '../runtime/registry.js';
import { permissionsPath } from '../snapshot/store.js';
import {
  consentScopeKey,
  grantConsent,
  hasAnyUserConsent,
  hasConsent,
  loadConsentStore,
  renderConsentPrompt,
  resolveAccessPolicy,
  type ConsentRequest,
} from './consent.js';

const tempHomes: string[] = [];

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pfl-consent-'));
  tempHomes.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempHomes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function fakeIO(answer: string): {
  prompts: string[];
  readAnswer: (prompt: string) => Promise<string>;
} {
  const prompts: string[] = [];
  return {
    prompts,
    readAnswer: async (prompt) => {
      prompts.push(prompt);
      return answer;
    },
  };
}

const request: ConsentRequest = {
  runtimeId: runtimeId('claude-code'),
  runtimeName: 'Claude Code',
  scope: 'user',
  groups: [
    { title: 'Project', locations: ['./CLAUDE.md', './.claude/**'] },
    { title: 'User', locations: ['~/.claude/settings.json'] },
  ],
};

describe('consent store', () => {
  it('starts empty and persists a grant', async () => {
    const home = await tempHome();
    expect(await loadConsentStore(home)).toEqual({ grantedScopes: [] });

    await grantConsent(consentScopeKey(runtimeId('claude-code'), 'user'), home);

    expect(await loadConsentStore(home)).toEqual({
      grantedScopes: ['claude-code:user'],
    });
    expect(((await stat(permissionsPath(home))).mode & 0o777).toString(8)).toBe('600');
    // The store is written the way the snapshot store writes artifacts: the
    // directory mode is re-asserted and no temp file is left behind (S10).
    expect(((await stat(dirname(permissionsPath(home)))).mode & 0o777).toString(8)).toBe('700');
    expect((await readdir(dirname(permissionsPath(home)))).some((n) => n.endsWith('.tmp'))).toBe(
      false,
    );
  });

  it('stores consent per runtime + scope', async () => {
    const home = await tempHome();
    await grantConsent(consentScopeKey(runtimeId('claude-code'), 'user'), home);
    const store = await loadConsentStore(home);

    expect(hasConsent(store, runtimeId('claude-code'), 'user')).toBe(true);
    expect(hasConsent(store, runtimeId('codex'), 'user')).toBe(false);
    expect(hasConsent(store, runtimeId('claude-code'), 'managed')).toBe(false);
  });

  it('hasAnyUserConsent ignores install grants but accepts any runtime user grant', async () => {
    const home = await tempHome();
    expect(await hasAnyUserConsent(home)).toBe(false);

    await grantConsent(consentScopeKey(runtimeId('claude-code'), 'install'), home);
    expect(await hasAnyUserConsent(home)).toBe(false);

    // Runtime-agnostic on purpose: read commands share a project id across
    // runtimes. This crossing is accepted risk A3 until M8 scopes it.
    await grantConsent(consentScopeKey(runtimeId('claude-code'), 'user'), home);
    expect(await hasAnyUserConsent(home)).toBe(true);
  });

  it('maps a store write failure to exit 6', async () => {
    const home = await tempHome();
    // A file where the store directory should go makes mkdir fail.
    await writeFile(join(home, '.pfl'), 'not a directory');

    await expect(grantConsent('claude-code:user', home)).rejects.toMatchObject({
      exitCode: EXIT_CODES.SNAPSHOT_STORE_FAILED,
    });
  });

  it('refuses a symlinked store path', async () => {
    const home = await tempHome();
    const outside = join(home, 'outside');
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(home, '.pfl'));

    expect(await loadConsentStore(home)).toEqual({ grantedScopes: [] });
    await expect(grantConsent('claude-code:user', home)).rejects.toMatchObject({
      exitCode: EXIT_CODES.SNAPSHOT_STORE_FAILED,
    });
  });
});

describe('resolveAccessPolicy', () => {
  it('allows immediately when already granted, without prompting', async () => {
    const home = await tempHome();
    await grantConsent('claude-code:user', home);
    const io = fakeIO('n');

    const policy = await resolveAccessPolicy(request, { home, interactive: true, io });

    expect(policy.user).toBe(true);
    expect(io.prompts).toHaveLength(0);
  });

  it('prompts once on an empty answer default is no', async () => {
    const home = await tempHome();
    const io = fakeIO('');

    const policy = await resolveAccessPolicy(request, { home, interactive: true, io });

    expect(policy.user).toBe(false);
    expect(io.prompts).toHaveLength(1);
    expect(await loadConsentStore(home)).toEqual({ grantedScopes: [] });
  });

  it('grants on y and does not prompt the next time', async () => {
    const home = await tempHome();
    const first = fakeIO('y');

    const policy = await resolveAccessPolicy(request, { home, interactive: true, io: first });
    expect(policy.user).toBe(true);

    const second = fakeIO('n');
    const again = await resolveAccessPolicy(request, { home, interactive: true, io: second });
    expect(again.user).toBe(true);
    expect(second.prompts).toHaveLength(0);
  });

  it('treats n as denial', async () => {
    const home = await tempHome();
    const policy = await resolveAccessPolicy(request, {
      home,
      interactive: true,
      io: fakeIO('n'),
    });

    expect(policy.user).toBe(false);
    expect(await loadConsentStore(home)).toEqual({ grantedScopes: [] });
  });

  it('fails closed when non-interactive', async () => {
    const home = await tempHome();

    await expect(resolveAccessPolicy(request, { home, interactive: false })).rejects.toMatchObject({
      exitCode: EXIT_CODES.CONSENT_REQUIRED,
    });
  });

  it('does not let a codex grant satisfy a claude-code check', async () => {
    const home = await tempHome();
    await grantConsent('codex:user', home);

    await expect(resolveAccessPolicy(request, { home, interactive: false })).rejects.toThrowError(
      PflError,
    );
  });
});

describe('renderConsentPrompt', () => {
  it('renders the real locations and the fixed will/will-not block', () => {
    // The real request, not a hand-written stand-in: this is what keeps the
    // prompt from silently underreporting the read scope (roadmap S2).
    const prompt = renderConsentPrompt(getConsentRequest('claude-code', 'user'));

    for (const line of [
      'Inventory needs read-only access to the following locations:',
      '  User and external references',
      '    ~/.claude/CLAUDE.md',
      '    ~/.claude/settings.json',
      '    ~/.claude/settings.local.json',
      '    ~/.claude/commands/**',
      '    ~/.claude/projects/**/memory/**',
      '    ~/.claude/plugins/**',
      '    ~/.claude.json',
      '  (Project-local discovery is implicit and needs no consent.)',
      'Inventory will:',
      '  ✓ Read files needed to resolve the effective harness',
      '  ✓ Process content locally',
      '  ✓ Store only digests and allowlisted metadata',
      '  ✗ Store file contents',
      '  ✗ Store environment values or credentials',
      '  ✗ Execute Claude Code or any discovered tool',
      '  ✗ Follow symlinks inside the listed locations',
    ]) {
      expect(prompt).toContain(line);
    }
    expect(prompt.endsWith('Allow this runtime scope? [y/N] ')).toBe(true);
  });

  it('renders the install scope with only its own will-line and locations', () => {
    const prompt = renderConsentPrompt(getConsentRequest('claude-code', 'install'));

    expect(prompt).toContain('  Installation and version metadata');
    expect(prompt).toContain('  ✓ Check the installed runtime version');
    // The install scope does not read the harness, so the prompt must not claim it.
    expect(prompt).not.toContain('Read files needed to resolve the effective harness');
    expect(prompt).not.toContain('~/.claude/CLAUDE.md');
  });
});
