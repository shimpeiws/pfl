import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_CODES } from './exit-codes.js';
import { resolveProjectContext } from '../discovery/project-identity.js';
import { latestPath, observationsDir, snapshotsDir } from '../snapshot/store.js';
import { runInspect } from './inspect.js';

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Fixture {
  project: string;
  home: string;
}

function fakeLogger(): { lines: string[]; warns: string[]; logger: ReturnType<typeof makeLogger> } {
  const lines: string[] = [];
  const warns: string[] = [];
  const logger = makeLogger(lines, warns);
  return { lines, warns, logger };
}

function makeLogger(lines: string[], warns: string[]) {
  const record = (target: string[], level: string, message: string, data?: unknown) => {
    target.push(
      data === undefined ? message : JSON.stringify({ level, message, ...(data as object) }),
    );
  };
  return {
    info: (message: string, data?: Record<string, unknown>) => {
      record(lines, 'info', message, data);
    },
    warn: (message: string, data?: Record<string, unknown>) => {
      record(warns, 'warn', message, data);
    },
    error: () => undefined,
  };
}

async function makeFixture(grantConsent: boolean): Promise<Fixture> {
  const base = await tempDir('pfl-inspect-');
  const project = join(base, 'project');
  const home = join(base, 'home');
  await mkdir(join(project, '.claude', 'skills', 'foo'), { recursive: true });
  await writeFile(join(project, 'CLAUDE.md'), '# Project instructions\n');
  await writeFile(join(project, '.claude', 'skills', 'foo', 'SKILL.md'), '# Foo\n');
  if (grantConsent) {
    await mkdir(join(home, '.pfl'), { recursive: true });
    await mkdir(join(home, '.claude', 'skills', 'bar'), { recursive: true });
    await writeFile(
      join(home, '.pfl', 'permissions.json'),
      JSON.stringify({ grantedScopes: ['claude-code:user'] }),
    );
    await writeFile(join(home, '.claude', 'skills', 'bar', 'SKILL.md'), '# Bar\n');
  }
  return { project, home };
}

describe('runInspect', () => {
  it('discovers, persists a snapshot, and renders the summary', async () => {
    const { project, home } = await makeFixture(true);
    const { lines, logger } = fakeLogger();

    await runInspect(
      project,
      { runtime: 'claude-code', home, pathValue: '', interactive: false },
      logger,
    );

    const output = lines.join('\n');
    expect(output).toContain('Inspecting Claude Code harness...');
    expect(output).toContain('Observed');
    expect(output).toContain('Effective');
    expect(output).toContain('Conditional');
    expect(output).toContain('Shadowed');
    expect(output).toContain('Opaque layers');
    expect(output).toContain('Store');
    expect(output).toMatch(/Store\s+~\/\.pfl\/projects\//);
    expect(output).not.toContain(home);
    expect(output).toContain('pfl report');

    const projectId = (await resolveProjectContext(project)).id;
    const observedFiles = await readdir(observationsDir(projectId, home));
    const resolvedFiles = await readdir(snapshotsDir(projectId, home));
    expect(observedFiles).toHaveLength(1);
    expect(observedFiles[0]).toMatch(/^obs_[0-9a-f]{12}\.json$/);
    expect(resolvedFiles[0]).toMatch(/^res_[0-9a-f]{12}\.json$/);

    const pointer = JSON.parse(await readFile(latestPath(projectId, home), 'utf8')) as {
      observed: string;
      resolved: string;
    };
    expect(pointer.observed).toMatch(/^obs_/);
    expect(pointer.resolved).toMatch(/^res_/);
  });

  it('renders the same facts as JSON', async () => {
    const { project, home } = await makeFixture(true);
    const { logger } = fakeLogger();

    const outcome = await runInspect(
      project,
      { runtime: 'claude-code', home, pathValue: '', interactive: false, json: true },
      logger,
    );

    const payload = outcome.data;
    expect(payload).toMatchObject({
      runtime: 'claude-code',
      observed: { completeness: 'complete' },
      // The isolated home has no Claude Code install, so the version is unverified.
      resolved: { confidence: 'unverified-runtime-version' },
    });
    expect(payload.observed.snapshotId).toMatch(/^obs_/);
    expect(payload.resolved.snapshotId).toMatch(/^res_/);
    // The store path is home-redacted: no raw home prefix, always ~/.pfl/projects/.
    expect(payload.store).toMatch(/^~\/\.pfl\/projects\//);
    expect(payload.store).not.toContain(home);
    // The temp home is used by discovery too, so the isolated fixture is fully
    // inspected (2 project files + 1 user skill + 1 opaque layer), all effective.
    expect(payload.observed.elements).toBe(4);
    expect(payload.resolved).toMatchObject({ effective: 4, conditional: 0, shadowed: 0 });
    expect(outcome.completeness).toBe('complete');
    // The §17 warning is not dropped from the document; it travels in the
    // envelope's flat diagnostics list.
    expect(outcome.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'runtime-version-unverified' })]),
    );
  });

  it('records a caller-supplied cell id as observation provenance (#212)', async () => {
    const { project, home } = await makeFixture(true);
    const { lines, logger } = fakeLogger();

    const outcome = await runInspect(
      project,
      {
        runtime: 'claude-code',
        home,
        pathValue: '',
        interactive: false,
        cellId: 'cell_20260928T120000Z-a1b2',
      },
      logger,
    );

    expect(outcome.data.observed.cellId).toBe('cell_20260928T120000Z-a1b2');
    expect(lines.join('\n')).toContain('cell_20260928T120000Z-a1b2');

    // The provenance is persisted on the observation event, so a stored
    // artifact — and any export of it — names the cell that was supplied.
    const projectId = (await resolveProjectContext(project)).id;
    const stored = JSON.parse(
      await readFile(
        join(observationsDir(projectId, home), `${outcome.data.observed.snapshotId}.json`),
        'utf8',
      ),
    ) as { provenance?: { cellId?: string } };
    expect(stored.provenance?.cellId).toBe('cell_20260928T120000Z-a1b2');
  });

  it('records a caller-declared source project as observation provenance (#217)', async () => {
    const { project, home } = await makeFixture(true);
    const { lines, logger } = fakeLogger();
    // The contract lives at the cell root, outside the inspected workspace.
    const contractPath = join(project, '..', 'source-project.json');
    await writeFile(
      contractPath,
      JSON.stringify({
        version: 1,
        issuer: 'yuurei',
        cell_id: 'cell_20260928T120000Z-a1b2',
        source_project: {
          id: 'git-0123456789abcdef',
          kind: 'git-remote',
          remote: 'github.com/owner/repo',
          source: '/home/operator/src/repo',
          head: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        },
      }),
    );

    const outcome = await runInspect(
      project,
      {
        runtime: 'claude-code',
        home,
        pathValue: '',
        interactive: false,
        cellId: 'cell_20260928T120000Z-a1b2',
        env: { YUUREI_SOURCE_PROJECT_FILE: contractPath },
      },
      logger,
    );

    expect(outcome.data.observed.sourceProject).toEqual({
      id: 'git-0123456789abcdef',
      kind: 'git-remote',
      remote: 'github.com/owner/repo',
      issuer: 'yuurei',
      contractVersion: 1,
      head: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    });
    expect(lines.join('\n')).toContain('git-0123456789abcdef');

    const projectId = (await resolveProjectContext(project)).id;
    const stored = JSON.parse(
      await readFile(
        join(observationsDir(projectId, home), `${outcome.data.observed.snapshotId}.json`),
        'utf8',
      ),
    ) as { provenance?: { sourceProject?: Record<string, unknown> } };
    // The host-side `source` path is asserted but not persisted (deny-by-default).
    expect(stored.provenance?.sourceProject).toEqual({
      id: 'git-0123456789abcdef',
      kind: 'git-remote',
      remote: 'github.com/owner/repo',
      issuer: 'yuurei',
      contractVersion: 1,
      head: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    });
    expect(JSON.stringify(stored)).not.toContain('/home/operator');
  });

  it('does not change digests.observed when a source project is declared (#217)', async () => {
    const plain = await makeFixture(true);
    const { logger: plainLogger } = fakeLogger();
    const without = await runInspect(
      plain.project,
      { runtime: 'claude-code', home: plain.home, pathValue: '', interactive: false },
      plainLogger,
    );

    const declared = await makeFixture(true);
    const { logger: declaredLogger } = fakeLogger();
    const contractPath = join(declared.project, '..', 'source-project.json');
    await writeFile(
      contractPath,
      JSON.stringify({
        version: 1,
        issuer: 'yuurei',
        cell_id: 'cell_x',
        source_project: { id: 'git-0123456789abcdef', kind: 'git-remote' },
      }),
    );
    const withDecl = await runInspect(
      declared.project,
      {
        runtime: 'claude-code',
        home: declared.home,
        pathValue: '',
        interactive: false,
        env: { YUUREI_SOURCE_PROJECT_FILE: contractPath },
      },
      declaredLogger,
    );

    // Provenance is metadata about the event, not harness content: the
    // observed digest over the elements is identical either way.
    const readDigest = async (project: string, home: string, snapshotId: string) => {
      const projectId = (await resolveProjectContext(project)).id;
      const stored = JSON.parse(
        await readFile(join(observationsDir(projectId, home), `${snapshotId}.json`), 'utf8'),
      ) as { digests: { observed: string } };
      return stored.digests.observed;
    };
    expect(
      await readDigest(declared.project, declared.home, withDecl.data.observed.snapshotId),
    ).toBe(await readDigest(plain.project, plain.home, without.data.observed.snapshotId));
  });

  it('reports an invalid declaration as a diagnostic without recording it (#217)', async () => {
    const { project, home } = await makeFixture(true);
    const { logger } = fakeLogger();
    const contractPath = join(project, '..', 'source-project.json');
    await writeFile(contractPath, '{ not json');

    const outcome = await runInspect(
      project,
      {
        runtime: 'claude-code',
        home,
        pathValue: '',
        interactive: false,
        env: { YUUREI_SOURCE_PROJECT_FILE: contractPath },
      },
      logger,
    );

    expect(outcome.data.observed.sourceProject).toBeNull();
    expect(outcome.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          code: 'source-project-declaration-invalid',
        }),
      ]),
    );

    const projectId = (await resolveProjectContext(project)).id;
    const stored = JSON.parse(
      await readFile(
        join(observationsDir(projectId, home), `${outcome.data.observed.snapshotId}.json`),
        'utf8',
      ),
    ) as { provenance?: unknown; completeness: string };
    // The caller's contract failure is not persisted as harness state and does
    // not drag the observation to `partial`.
    expect(stored.provenance).toBeUndefined();
    expect(stored.completeness).toBe('complete');
  });

  it('does not auto-discover a contract file outside the workspace (#217)', async () => {
    const { project, home } = await makeFixture(true);
    const { logger } = fakeLogger();
    // A contract-shaped file sits at the parent directory — where a cell root
    // would be — but no env var points at it, so it must not be read.
    await writeFile(
      join(project, '..', 'source-project.json'),
      JSON.stringify({
        version: 1,
        issuer: 'yuurei',
        cell_id: 'cell_x',
        source_project: { id: 'git-0123456789abcdef', kind: 'git-remote' },
      }),
    );

    const outcome = await runInspect(
      project,
      { runtime: 'claude-code', home, pathValue: '', interactive: false, env: {} },
      logger,
    );

    expect(outcome.data.observed.sourceProject).toBeNull();
    expect(
      outcome.diagnostics.filter((d) => d.code.startsWith('source-project-declaration')),
    ).toEqual([]);
  });

  it('rejects a declaration whose cell_id disagrees with --cell-id (#217)', async () => {
    const { project, home } = await makeFixture(true);
    const { logger } = fakeLogger();
    const contractPath = join(project, '..', 'source-project.json');
    await writeFile(
      contractPath,
      JSON.stringify({
        version: 1,
        issuer: 'yuurei',
        cell_id: 'cell_other',
        source_project: { id: 'git-0123456789abcdef', kind: 'git-remote' },
      }),
    );

    const outcome = await runInspect(
      project,
      {
        runtime: 'claude-code',
        home,
        pathValue: '',
        interactive: false,
        cellId: 'cell_this',
        env: { YUUREI_SOURCE_PROJECT_FILE: contractPath },
      },
      logger,
    );

    expect(outcome.data.observed.sourceProject).toBeNull();
    expect(outcome.data.observed.cellId).toBe('cell_this');
    expect(outcome.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'source-project-declaration-mismatch' }),
      ]),
    );
  });

  it('records no provenance on a standalone run', async () => {
    const { project, home } = await makeFixture(true);
    const { logger } = fakeLogger();

    const outcome = await runInspect(
      project,
      { runtime: 'claude-code', home, pathValue: '', interactive: false },
      logger,
    );

    expect(outcome.data.observed.cellId).toBeNull();
    const projectId = (await resolveProjectContext(project)).id;
    const stored = JSON.parse(
      await readFile(
        join(observationsDir(projectId, home), `${outcome.data.observed.snapshotId}.json`),
        'utf8',
      ),
    ) as { provenance?: unknown };
    expect(stored.provenance).toBeUndefined();
  });

  it('rejects an out-of-bounds cell id before any store write', async () => {
    const { project, home } = await makeFixture(true);
    const { logger } = fakeLogger();

    for (const cellId of [
      '',
      'has space',
      'no/slash',
      '-leading',
      'x'.repeat(129),
      'trailing-newline\n',
    ]) {
      await expect(
        runInspect(
          project,
          { runtime: 'claude-code', home, pathValue: '', interactive: false, cellId },
          logger,
        ),
      ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONFIG_ERROR });
    }

    const projectId = (await resolveProjectContext(project)).id;
    expect(await readdir(observationsDir(projectId, home)).catch(() => [])).toEqual([]);
  });

  it('rejects an unknown runtime with RUNTIME_UNSUPPORTED', async () => {
    const { project, home } = await makeFixture(true);
    const { logger } = fakeLogger();

    await expect(
      runInspect(project, { runtime: 'bogus', home, pathValue: '', interactive: false }, logger),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.RUNTIME_UNSUPPORTED });
  });

  it('fails closed when consent is missing and the run is non-interactive', async () => {
    const { project, home } = await makeFixture(false);
    const { logger } = fakeLogger();

    await expect(
      runInspect(
        project,
        { runtime: 'claude-code', home, pathValue: '', interactive: false },
        logger,
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONSENT_REQUIRED });
  });

  it('continues project-locally when consent is denied interactively', async () => {
    const { project, home } = await makeFixture(false);
    const { lines, logger } = fakeLogger();
    const io = { readAnswer: async () => 'n' };

    await runInspect(
      project,
      { runtime: 'claude-code', home, pathValue: '', interactive: true, io },
      logger,
    );

    expect(lines.join('\n')).toContain('Observed');
    const projectId = (await resolveProjectContext(project)).id;
    expect(await readdir(snapshotsDir(projectId, home))).toHaveLength(1);
  });
});
