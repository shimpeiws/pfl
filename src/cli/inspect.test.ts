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

    await runInspect(project, { runtime: 'claude-code', home, interactive: false }, logger);

    const output = lines.join('\n');
    expect(output).toContain('Inspecting Claude Code harness...');
    expect(output).toContain('Observed');
    expect(output).toContain('Effective');
    expect(output).toContain('Conditional');
    expect(output).toContain('Shadowed');
    expect(output).toContain('Opaque layers');
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
    const { lines, logger } = fakeLogger();

    await runInspect(
      project,
      { runtime: 'claude-code', home, interactive: false, json: true },
      logger,
    );

    const payload = JSON.parse(lines[0] ?? '{}');
    expect(payload).toMatchObject({
      runtime: 'claude-code',
      observed: { completeness: 'complete' },
      // The isolated home has no Claude Code install, so the version is unverified.
      resolved: { confidence: 'unverified-runtime-version' },
    });
    expect(payload.observed.snapshotId).toMatch(/^obs_/);
    expect(payload.resolved.snapshotId).toMatch(/^res_/);
    // The temp home is used by discovery too, so the isolated fixture is fully
    // inspected (2 project files + 1 user skill + 1 opaque layer), all effective.
    expect(payload.observed.elements).toBe(4);
    expect(payload.resolved).toMatchObject({ effective: 4, conditional: 0, shadowed: 0 });
  });

  it('rejects an unknown runtime with RUNTIME_UNSUPPORTED', async () => {
    const { project, home } = await makeFixture(true);
    const { logger } = fakeLogger();

    await expect(
      runInspect(project, { runtime: 'bogus', home, interactive: false }, logger),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.RUNTIME_UNSUPPORTED });
  });

  it('fails closed when consent is missing and the run is non-interactive', async () => {
    const { project, home } = await makeFixture(false);
    const { logger } = fakeLogger();

    await expect(
      runInspect(project, { runtime: 'claude-code', home, interactive: false }, logger),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONSENT_REQUIRED });
  });

  it('continues project-locally when consent is denied interactively', async () => {
    const { project, home } = await makeFixture(false);
    const { lines, logger } = fakeLogger();
    const io = { readAnswer: async () => 'n' };

    await runInspect(project, { runtime: 'claude-code', home, interactive: true, io }, logger);

    expect(lines.join('\n')).toContain('Observed');
    const projectId = (await resolveProjectContext(project)).id;
    expect(await readdir(snapshotsDir(projectId, home))).toHaveLength(1);
  });
});
