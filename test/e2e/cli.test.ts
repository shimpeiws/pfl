import { execFile, spawn } from 'node:child_process';
import { rm, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_CODES } from '../../src/cli/exit-codes.js';
import {
  grantConsent,
  materialize,
  type FixtureRuntime,
  type Materialized,
} from '../fixtures/materialize.js';

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliEntry = join(repoRoot, 'dist', 'index.js');

const materialized: Materialized[] = [];

beforeAll(async () => {
  await execFileAsync('pnpm', ['run', 'build'], { cwd: repoRoot });
}, 120_000);

afterEach(async () => {
  await Promise.all(
    materialized.splice(0).map((m) => rm(m.base, { recursive: true, force: true, maxRetries: 3 })),
  );
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(m: Materialized, args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: m.projectRoot,
      env: { ...process.env, HOME: m.home },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function fixture(runtime: FixtureRuntime = 'claude'): Promise<Materialized> {
  const m = await materialize(runtime);
  materialized.push(m);
  await grantConsent(m.home, runtime);
  return m;
}

describe('pfl CLI end to end', () => {
  it('inspects a harness and exits 0', async () => {
    const m = await fixture();

    const result = await runCli(m, ['inspect', '--runtime', 'claude-code']);

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(result.stdout).toContain('Observed');
    expect(result.stdout).toContain('resolved');
  });

  it('rejects an unknown runtime with exit 3', async () => {
    const m = await fixture();

    const result = await runCli(m, ['inspect', '--runtime', 'bogus']);

    expect(result.code).toBe(EXIT_CODES.RUNTIME_UNSUPPORTED);
  });

  it('runs the read commands against the stored snapshot', async () => {
    const m = await fixture();
    await runCli(m, ['inspect', '--runtime', 'claude-code']);

    for (const args of [['report'], ['list'], ['graph'], ['snapshots']]) {
      const result = await runCli(m, args);
      expect(result.code, `${args.join(' ')}: ${result.stderr}`).toBe(EXIT_CODES.SUCCESS);
    }
  });

  it('rejects an invalid filter with exit 2 and lists the valid values', async () => {
    const m = await fixture();
    await runCli(m, ['inspect', '--runtime', 'claude-code']);

    const result = await runCli(m, ['list', '--facet', 'telepathy']);

    expect(result.code).toBe(EXIT_CODES.CONFIG_ERROR);
    expect(result.stderr).toContain('instructions');
  });

  it('diffs a snapshot against itself as an all-zero diff', async () => {
    const m = await fixture();
    await runCli(m, ['inspect', '--runtime', 'claude-code']);
    const snapshots = await runCli(m, ['snapshots', '--json']);
    const payload = JSON.parse(snapshots.stdout.trim().split('\n').at(-1) ?? '{}');
    const resolvedId: string = payload.runs[0].resolvedId;

    const result = await runCli(m, ['diff', resolvedId, resolvedId]);

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(result.stdout).toContain('+ 0 added');
    expect(result.stdout).toContain('+ 0 newly effective');
  });

  it('inspects a Codex harness and reads back Codex-specific content', async () => {
    const m = await fixture('codex');

    const inspect = await runCli(m, ['inspect', '--runtime', 'codex']);
    expect(inspect.code, inspect.stderr).toBe(EXIT_CODES.SUCCESS);
    expect(inspect.stdout).toContain('Observed');

    for (const args of [['report'], ['list'], ['graph'], ['snapshots']]) {
      const result = await runCli(m, args);
      expect(result.code, `${args.join(' ')}: ${result.stderr}`).toBe(EXIT_CODES.SUCCESS);
    }

    // Codex-specific evidence, not just "it exited 0": the provenance path and
    // the runtime id must actually be Codex, so a silent claude-code fallback
    // or an empty harness would fail.
    const graph = await runCli(m, ['graph']);
    expect(graph.stdout).toContain('~/.codex');

    const snapshots = await runCli(m, ['snapshots']);
    expect(snapshots.stdout).toContain('codex@');

    const list = await runCli(m, ['list', '--json']);
    const listed = JSON.parse(list.stdout.trim().split('\n').at(-1) ?? '{}');
    const userElement = listed.elements.find(
      (element: { origin: string }) => element.origin === 'user',
    );
    const show = await runCli(m, ['show', userElement.id]);
    expect(show.code, show.stderr).toBe(EXIT_CODES.SUCCESS);
    expect(show.stdout).toContain('~/.codex');

    const snapshotsJson = await runCli(m, ['snapshots', '--json']);
    const payload = JSON.parse(snapshotsJson.stdout.trim().split('\n').at(-1) ?? '{}');
    const resolvedId: string = payload.runs[0].resolvedId;
    const diff = await runCli(m, ['diff', resolvedId, resolvedId]);
    expect(diff.code, diff.stderr).toBe(EXIT_CODES.SUCCESS);
    expect(diff.stdout).toContain('+ 0 added');
  });

  it('reports the package version from the packed layout', async () => {
    const m = await fixture();
    const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };

    const result = await runCli(m, ['--version']);

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(result.stdout.trim()).toContain(manifest.version);
  });
});
