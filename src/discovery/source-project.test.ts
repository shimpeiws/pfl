import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SOURCE_PROJECT_FILE_ENV,
  SOURCE_PROJECT_ID_ENV,
  resolveSourceProjectDeclaration,
} from './source-project.js';

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const CONTRACT_ID = 'git-0123456789abcdef';
const CELL_ID = 'cell_20260928T120000Z-a1b2';

function contract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    issuer: 'yuurei',
    cell_id: CELL_ID,
    source_project: {
      id: CONTRACT_ID,
      kind: 'git-remote',
      remote: 'github.com/owner/repo',
      source: '/home/operator/src/repo',
      head: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      ...((overrides['source_project'] as Record<string, unknown> | undefined) ?? {}),
    },
    ...overrides,
  };
}

async function writeContract(dir: string, value: unknown): Promise<string> {
  const path = join(dir, 'source-project.json');
  await writeFile(path, `${JSON.stringify(value)}\n`, 'utf8');
  return path;
}

function envFor(path: string, id?: string): Record<string, string | undefined> {
  return {
    [SOURCE_PROJECT_FILE_ENV]: path,
    ...(id !== undefined ? { [SOURCE_PROJECT_ID_ENV]: id } : {}),
  };
}

describe('resolveSourceProjectDeclaration', () => {
  it('records a valid declaration verbatim, minus the host source path', async () => {
    const dir = await tempDir('pfl-sp-');
    const path = await writeContract(dir, contract());

    const result = await resolveSourceProjectDeclaration({
      env: envFor(path, CONTRACT_ID),
      cellId: CELL_ID,
    });

    expect(result).toEqual({
      status: 'declared',
      sourceProject: {
        id: CONTRACT_ID,
        kind: 'git-remote',
        remote: 'github.com/owner/repo',
        issuer: 'yuurei',
        contractVersion: 1,
        head: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      },
    });
    // The declared value carries no `source`: a host path is never persisted.
    expect(JSON.stringify(result)).not.toContain('/home/operator');
  });

  it('accepts a local-path declaration without remote or head', async () => {
    const dir = await tempDir('pfl-sp-');
    const path = await writeContract(
      dir,
      contract({
        source_project: {
          id: 'path-0123456789abcdef',
          kind: 'local-path',
          source: '/x',
          head: 'h',
        },
      }),
    );

    const result = await resolveSourceProjectDeclaration({ env: envFor(path) });

    expect(result).toEqual({
      status: 'declared',
      sourceProject: {
        id: 'path-0123456789abcdef',
        kind: 'local-path',
        issuer: 'yuurei',
        contractVersion: 1,
        head: 'h',
      },
    });
  });

  it('is absent when neither env var is set', async () => {
    const result = await resolveSourceProjectDeclaration({ env: {} });
    expect(result).toEqual({ status: 'absent' });
  });

  it('reports an env id without a contract file as an incomplete declaration', async () => {
    const result = await resolveSourceProjectDeclaration({
      env: { [SOURCE_PROJECT_ID_ENV]: CONTRACT_ID },
    });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('unreachable');
    expect(result.diagnostic.code).toBe('source-project-declaration-incomplete');
  });

  it('treats an unreadable or missing contract as invalid, not absent', async () => {
    const dir = await tempDir('pfl-sp-');
    const result = await resolveSourceProjectDeclaration({
      env: envFor(join(dir, 'missing.json')),
    });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('unreachable');
    expect(result.diagnostic.code).toBe('source-project-declaration-unreadable');
    expect(result.diagnostic.path).toBe(join(dir, 'missing.json'));
  });

  it('refuses a symlinked contract file', async () => {
    const dir = await tempDir('pfl-sp-');
    const real = await writeContract(dir, contract());
    const link = join(dir, 'linked.json');
    await symlink(real, link);

    const result = await resolveSourceProjectDeclaration({ env: envFor(link) });

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('unreachable');
    expect(result.diagnostic.code).toBe('source-project-declaration-unreadable');
  });

  it('rejects non-JSON and non-object contracts', async () => {
    const dir = await tempDir('pfl-sp-');
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{ not json');
    const array = join(dir, 'array.json');
    await writeFile(array, '[1]');

    for (const path of [bad, array]) {
      const result = await resolveSourceProjectDeclaration({ env: envFor(path) });
      expect(result.status).toBe('invalid');
      if (result.status !== 'invalid') throw new Error('unreachable');
      expect(result.diagnostic.code).toBe('source-project-declaration-invalid');
    }
  });

  it('rejects an unsupported contract version without echoing its raw value', async () => {
    const dir = await tempDir('pfl-sp-');
    // `version` is unvalidated caller text at this point; a hostile value must
    // not ride the diagnostic message (#217, review C-1).
    const path = await writeContract(dir, contract({ version: 'password=hunter2' }));

    const result = await resolveSourceProjectDeclaration({ env: envFor(path) });

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('unreachable');
    expect(result.diagnostic.code).toBe('source-project-declaration-invalid');
    expect(result.diagnostic.message).toContain('unsupported source-project contract version');
    expect(result.diagnostic.message).not.toContain('hunter2');
  });

  it('rejects malformed ids, kinds, issuers, and cell ids', async () => {
    const dir = await tempDir('pfl-sp-');
    const cases: Record<string, unknown>[] = [
      contract({ cell_id: 'has space' }),
      contract({ source_project: { id: 'bogus', kind: 'git-remote' } }),
      contract({ source_project: { id: CONTRACT_ID, kind: 'magic' } }),
      contract({ issuer: '' }),
      contract({ issuer: 'x'.repeat(65) }),
      // Asserted free text is echoed in documents and the human-facing
      // summary; control characters would carry terminal escapes through.
      contract({ issuer: 'yuurei\u001b[31m' }),
      // Bidi overrides, zero-width spaces, and line/paragraph separators are
      // format/separator characters (Cf/Zl/Zp), not controls: they pass
      // \p{Cc} alone but can reorder or hide displayed output (#217, review
      // C-1 r7).
      contract({ issuer: 'yuurei\u202e\u200b' }),
      contract({ issuer: 'yuurei\u2028line' }),
      contract({
        source_project: { id: CONTRACT_ID, kind: 'git-remote', remote: 'github.com/o/r\n' },
      }),
      contract({
        source_project: { id: CONTRACT_ID, kind: 'git-remote', head: 'abc\u0007' },
      }),
      contract({
        source_project: { id: CONTRACT_ID, kind: 'git-remote', remote: 'r'.repeat(513) },
      }),
    ];
    for (const value of cases) {
      const path = await writeContract(dir, value);
      const result = await resolveSourceProjectDeclaration({ env: envFor(path) });
      expect(result.status, JSON.stringify(value)).toBe('invalid');
      if (result.status !== 'invalid') throw new Error('unreachable');
      expect(result.diagnostic.code).toBe('source-project-declaration-invalid');
    }
  });

  it('rejects a contract whose cell_id does not match --cell-id', async () => {
    const dir = await tempDir('pfl-sp-');
    const path = await writeContract(dir, contract({ cell_id: 'cell_other' }));

    const result = await resolveSourceProjectDeclaration({ env: envFor(path), cellId: CELL_ID });

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('unreachable');
    expect(result.diagnostic.code).toBe('source-project-declaration-mismatch');
    expect(result.diagnostic.path).toBe(path);
  });

  it('accepts a contract whose cell_id matches --cell-id', async () => {
    const dir = await tempDir('pfl-sp-');
    const path = await writeContract(dir, contract());

    const result = await resolveSourceProjectDeclaration({ env: envFor(path), cellId: CELL_ID });

    expect(result.status).toBe('declared');
  });

  it('rejects a declaration whose id prefix and kind disagree', async () => {
    const dir = await tempDir('pfl-sp-');
    for (const source_project of [
      { id: 'path-0123456789abcdef', kind: 'git-remote' },
      { id: 'git-0123456789abcdef', kind: 'local-path' },
    ]) {
      const path = await writeContract(dir, contract({ source_project }));
      const result = await resolveSourceProjectDeclaration({ env: envFor(path) });
      expect(result.status, JSON.stringify(source_project)).toBe('invalid');
      if (result.status !== 'invalid') throw new Error('unreachable');
      expect(result.diagnostic.code).toBe('source-project-declaration-invalid');
    }
  });

  it('rejects a declaration whose kind and remote disagree', async () => {
    const dir = await tempDir('pfl-sp-');
    // `remote` describes the remote the `git-remote` derivation used; a
    // `local-path` declaration carrying one is self-contradictory (#217,
    // review C-2).
    const path = await writeContract(
      dir,
      contract({
        source_project: {
          id: 'path-0123456789abcdef',
          kind: 'local-path',
          remote: 'github.com/owner/repo',
        },
      }),
    );

    const result = await resolveSourceProjectDeclaration({ env: envFor(path) });

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('unreachable');
    expect(result.diagnostic.code).toBe('source-project-declaration-invalid');
  });

  it('rejects a declaration whose redacted value would exceed the bounds', async () => {
    const dir = await tempDir('pfl-sp-');
    // `token=a` is masked to `token=[redacted]`, which is longer than the
    // text it replaces: a value at the issuer bound grows past it, and the
    // reader holds the same bound on the stored value — recording it would
    // write an artifact that fails validation on read (#217, review F-1).
    const issuer = `${'x '.repeat(28)} token=a`; // 64 chars, at the bound
    const path = await writeContract(dir, contract({ issuer }));

    const result = await resolveSourceProjectDeclaration({ env: envFor(path) });

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('unreachable');
    expect(result.diagnostic.code).toBe('source-project-declaration-invalid');
  });

  it('redacts credential-shaped text out of the recorded strings', async () => {
    const dir = await tempDir('pfl-sp-');
    const path = await writeContract(
      dir,
      contract({
        issuer: 'yuurei password=hunter2',
        source_project: {
          id: CONTRACT_ID,
          kind: 'git-remote',
          remote: 'https://x-access-token:SECRETVALUE9@github.com/owner/repo',
          source: '/x',
          head: 'token=abc123def456abc123def456',
        },
      }),
    );

    const result = await resolveSourceProjectDeclaration({ env: envFor(path) });

    expect(result.status).toBe('declared');
    if (result.status !== 'declared') throw new Error('unreachable');
    const serialized = JSON.stringify(result.sourceProject);
    for (const secret of ['SECRETVALUE9', 'hunter2', 'abc123def456abc123def456']) {
      expect(serialized).not.toContain(secret);
    }
    expect(result.sourceProject.remote).toContain('[redacted]');
  });

  it('rejects an env id that disagrees with the contract', async () => {
    const dir = await tempDir('pfl-sp-');
    const path = await writeContract(dir, contract());

    const result = await resolveSourceProjectDeclaration({
      env: envFor(path, 'git-ffffffffffffffff'),
    });

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('unreachable');
    expect(result.diagnostic.code).toBe('source-project-declaration-mismatch');
    expect(result.diagnostic.path).toBe(path);
  });

  it('does not echo an unvalidated env id into the mismatch diagnostic', async () => {
    const dir = await tempDir('pfl-sp-');
    const path = await writeContract(dir, contract());
    // The env id is caller-controlled and unvalidated at this point; embedding
    // it raw would let control characters or credential-shaped text reach the
    // diagnostic stream (#217, FIND-003 r2).
    const hostile = 'bad\nvalue password=hunter2';

    const result = await resolveSourceProjectDeclaration({ env: envFor(path, hostile) });

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('unreachable');
    expect(result.diagnostic.code).toBe('source-project-declaration-mismatch');
    expect(result.diagnostic.message).not.toContain('bad\nvalue');
    expect(result.diagnostic.message).not.toContain('hunter2');
  });
});
