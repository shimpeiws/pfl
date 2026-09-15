import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_CODES, PflError } from '../cli/exit-codes.js';
import { runtimeId } from '../core/ids.js';
import { permissionsPath } from '../snapshot/store.js';
import {
  consentScopeKey,
  grantConsent,
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
  });

  it('stores consent per runtime + scope', async () => {
    const home = await tempHome();
    await grantConsent(consentScopeKey(runtimeId('claude-code'), 'user'), home);
    const store = await loadConsentStore(home);

    expect(hasConsent(store, runtimeId('claude-code'), 'user')).toBe(true);
    expect(hasConsent(store, runtimeId('codex'), 'user')).toBe(false);
    expect(hasConsent(store, runtimeId('claude-code'), 'managed')).toBe(false);
  });
});

describe('resolveAccessPolicy', () => {
  it('allows immediately when already granted, without prompting', async () => {
    const home = await tempHome();
    await grantConsent('claude-code:user', home);
    const io = fakeIO('n');

    const policy = await resolveAccessPolicy(request, { home, interactive: true, io });

    expect(policy.allowOutsideProject).toBe(true);
    expect(io.prompts).toHaveLength(0);
  });

  it('prompts once on an empty answer default is no', async () => {
    const home = await tempHome();
    const io = fakeIO('');

    const policy = await resolveAccessPolicy(request, { home, interactive: true, io });

    expect(policy.allowOutsideProject).toBe(false);
    expect(io.prompts).toHaveLength(1);
    expect(await loadConsentStore(home)).toEqual({ grantedScopes: [] });
  });

  it('grants on y and does not prompt the next time', async () => {
    const home = await tempHome();
    const first = fakeIO('y');

    const policy = await resolveAccessPolicy(request, { home, interactive: true, io: first });
    expect(policy.allowOutsideProject).toBe(true);

    const second = fakeIO('n');
    const again = await resolveAccessPolicy(request, { home, interactive: true, io: second });
    expect(again.allowOutsideProject).toBe(true);
    expect(second.prompts).toHaveLength(0);
  });

  it('treats n as denial', async () => {
    const home = await tempHome();
    const policy = await resolveAccessPolicy(request, {
      home,
      interactive: true,
      io: fakeIO('n'),
    });

    expect(policy.allowOutsideProject).toBe(false);
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
  it('renders the §24 locations and the fixed will/will-not block', () => {
    const prompt = renderConsentPrompt(request);

    for (const line of [
      'Inventory needs read-only access to the following locations:',
      '  Project',
      '    ./CLAUDE.md',
      '    ./.claude/**',
      '  User',
      '    ~/.claude/settings.json',
      'Inventory will:',
      '  ✓ Read files needed to resolve the effective harness',
      '  ✓ Check the installed runtime version',
      '  ✓ Process content locally',
      '  ✓ Store only digests and allowlisted metadata',
      '  ✗ Store file contents',
      '  ✗ Store environment values or credentials',
      '  ✗ Execute Claude Code or any discovered tool',
      '  ✗ Follow symlinks',
    ]) {
      expect(prompt).toContain(line);
    }
    expect(prompt.endsWith('Allow this runtime scope? [y/N] ')).toBe(true);
  });
});
