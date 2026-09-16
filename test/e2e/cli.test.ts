import { execFile, spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_CODES } from '../../src/cli/exit-codes.js';
import { grantConsent, materialize, type Materialized } from '../fixtures/materialize.js';

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

async function fixture(): Promise<Materialized> {
  const m = await materialize('claude');
  materialized.push(m);
  await grantConsent(m.home, 'claude');
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
});
