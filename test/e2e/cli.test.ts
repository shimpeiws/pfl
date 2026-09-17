import { execFile, spawn } from 'node:child_process';
import { rm, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_CODES } from '../../src/cli/exit-codes.js';
import { elementIdFor, runtimeId } from '../../src/core/ids.js';
import { resolveProjectContext } from '../../src/discovery/project-identity.js';
import { interpretationsDir, readLatestPointer, snapshotsDir } from '../../src/snapshot/store.js';
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
      // An empty PATH keeps detection hermetic: the fixture has no installer
      // metadata, and the test must not read the machine's own installs.
      env: { ...process.env, HOME: m.home, PATH: '' },
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
    const payload = JSON.parse(snapshots.stdout);
    const resolvedId: string = payload.data.runs[0].resolvedId;

    const result = await runCli(m, ['diff', resolvedId, resolvedId]);

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    expect(result.stdout).toContain('+ 0 added');
    expect(result.stdout).toContain('+ 0 newly effective');
  });

  it('defaults the second diff operand to latest and accepts the literal latest', async () => {
    const m = await fixture();
    await runCli(m, ['inspect', '--runtime', 'claude-code']);
    const snapshots = await runCli(m, ['snapshots', '--json']);
    const resolvedId: string = JSON.parse(snapshots.stdout).data.runs[0].resolvedId;

    // One positional: the second operand defaults to the latest resolved snapshot.
    const defaulted = await runCli(m, ['diff', resolvedId]);
    expect(defaulted.code, defaulted.stderr).toBe(EXIT_CODES.SUCCESS);
    expect(defaulted.stdout).toContain('+ 0 added');

    // The literal `latest` is accepted anywhere an id is.
    const literalSecond = await runCli(m, ['diff', resolvedId, 'latest']);
    expect(literalSecond.code, literalSecond.stderr).toBe(EXIT_CODES.SUCCESS);
    expect(literalSecond.stdout).toContain('+ 0 added');

    const literalFirst = await runCli(m, ['diff', 'latest']);
    expect(literalFirst.code, literalFirst.stderr).toBe(EXIT_CODES.SUCCESS);
    expect(literalFirst.stdout).toContain('+ 0 added');
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
    const listed = JSON.parse(list.stdout);
    const userElement = listed.data.elements.find(
      (element: { origin: string }) => element.origin === 'user',
    );
    const show = await runCli(m, ['show', userElement.id]);
    expect(show.code, show.stderr).toBe(EXIT_CODES.SUCCESS);
    expect(show.stdout).toContain('~/.codex');

    const snapshotsJson = await runCli(m, ['snapshots', '--json']);
    const payload = JSON.parse(snapshotsJson.stdout);
    const resolvedId: string = payload.data.runs[0].resolvedId;
    const diff = await runCli(m, ['diff', resolvedId, resolvedId]);
    expect(diff.code, diff.stderr).toBe(EXIT_CODES.SUCCESS);
    expect(diff.stdout).toContain('+ 0 added');
  });

  it('resolves the Codex project skills and the AGENTS.md tree', async () => {
    const m = await fixture('codex');
    const inspect = await runCli(m, ['inspect', '--runtime', 'codex']);
    expect(inspect.code, inspect.stderr).toBe(EXIT_CODES.SUCCESS);

    const idFor = (path: string, kind: string): string =>
      elementIdFor({ runtimeId: runtimeId('codex'), origin: 'project', path, kind });
    const show = async (path: string, kind: string) => {
      const result = await runCli(m, ['show', idFor(path, kind), '--json']);
      expect(result.code, `${path}: ${result.stderr}`).toBe(EXIT_CODES.SUCCESS);
      return JSON.parse(result.stdout).data as {
        observed: { native: { kind: string; origin: string; scope: string } };
        resolved: { status: string; applicability: { type: string; target?: string } };
      };
    };

    // A project-scoped skill, discovered under `<project>/.codex/skills/**`.
    const skill = await show('.codex/skills/project-skill/SKILL.md', 'skills');
    expect(skill.observed.native).toMatchObject({
      kind: 'skills',
      origin: 'project',
      scope: 'project',
    });
    expect(skill.resolved).toMatchObject({
      status: 'effective',
      applicability: { type: 'project' },
    });

    // A nested AGENTS.md governs its own directory subtree.
    const nested = await show('docs/AGENTS.md', 'instructions');
    expect(nested.resolved).toMatchObject({
      status: 'effective',
      applicability: { type: 'directory-subtree', target: 'docs' },
    });

    // The parent-directory file is read under consent and is global.
    const parent = await show('../AGENTS.md', 'instructions');
    expect(parent.resolved.applicability).toEqual({ type: 'global' });

    // Same-directory override shadows the base; the nested base in a different
    // directory is not shadowed by any override.
    expect((await show('AGENTS.md', 'instructions')).resolved.status).toBe('shadowed');
    expect((await show('AGENTS.override.md', 'fallback-instructions')).resolved.status).toBe(
      'effective',
    );
    expect(nested.resolved.status).toBe('effective');
  });

  it('stores the corrected Codex kinds and the permission counts', async () => {
    const m = await fixture('codex');
    const inspect = await runCli(m, ['inspect', '--runtime', 'codex']);
    expect(inspect.code, inspect.stderr).toBe(EXIT_CODES.SUCCESS);

    const idFor = (path: string, kind: string): string =>
      elementIdFor({ runtimeId: runtimeId('codex'), origin: 'user', path, kind });
    const show = async (path: string, kind: string) => {
      const result = await runCli(m, ['show', idFor(path, kind), '--json']);
      expect(result.code, `${path}: ${result.stderr}`).toBe(EXIT_CODES.SUCCESS);
      return JSON.parse(result.stdout).data as {
        observed: {
          native: { kind: string; origin: string; scope: string };
          metadata: Record<string, unknown>;
        };
      };
    };

    // `model` and its behavior siblings are model configuration, not compaction
    // controls; the real context controls live on the `#context` element.
    const model = await show('~/.codex/config.toml#model', 'model-configuration');
    expect(model.observed.native.kind).toBe('model-configuration');
    expect(model.observed.metadata).toMatchObject({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'medium',
      serviceTier: 'flex',
    });
    const context = await show('~/.codex/config.toml#context', 'compaction-controls');
    expect(context.observed.native.kind).toBe('compaction-controls');
    expect(context.observed.metadata).toMatchObject({
      contextWindow: 272000,
      maxOutputTokens: 128000,
      autoCompactTokenLimit: 200000,
    });
    expect(context.observed.metadata).not.toHaveProperty('model');

    // `rules/**` is instructional content; its permission counts are a second
    // element, and only the counts are stored.
    const rules = await show('~/.codex/rules/default.rules', 'rules');
    expect(rules.observed.native.kind).toBe('rules');
    expect(rules.observed.metadata).not.toHaveProperty('allowCount');
    const permissions = await show('~/.codex/rules/default.rules#permissions', 'permissions');
    expect(permissions.observed.native.kind).toBe('permissions');
    expect(permissions.observed.metadata).toMatchObject({ allowCount: 3, denyCount: 1 });

    // `skill-dependencies` rides on the `skills` kind as frontmatter metadata.
    const skill = await show('~/.codex/skills/tool.md', 'skills');
    expect(skill.observed.native.kind).toBe('skills');
    expect(skill.observed.metadata).toMatchObject({
      dependencyNames: ['fixture-foundation', 'fixture-formatting'],
    });
  });

  it('resolves the Claude Code depth: MCP, plugins, hooks, approval, and the CLAUDE.md tree', async () => {
    const m = await fixture('claude');
    const inspect = await runCli(m, ['inspect', '--runtime', 'claude-code']);
    expect(inspect.code, inspect.stderr).toBe(EXIT_CODES.SUCCESS);

    const show = async (origin: 'project' | 'user' | 'plugin', path: string, kind: string) => {
      const id = elementIdFor({ runtimeId: runtimeId('claude-code'), origin, path, kind });
      const result = await runCli(m, ['show', id, '--json']);
      expect(result.code, `${path}: ${result.stderr}`).toBe(EXIT_CODES.SUCCESS);
      return JSON.parse(result.stdout).data as {
        observed: {
          native: { kind: string; origin: string; scope: string };
          metadata: Record<string, unknown>;
        };
        resolved: { status: string; applicability: { type: string; target?: string } };
      };
    };

    // `.mcp.json` is parsed for server names, not only digested.
    const mcp = await show('project', '.mcp.json#mcpServers', 'mcp-configuration');
    expect(mcp.observed.native.kind).toBe('mcp-configuration');
    expect(mcp.observed.metadata).toEqual({ serverNames: ['fixture'] });

    // The approval mode lives under `permissions.defaultMode` and is its own kind.
    const approval = await show('project', '.claude/settings.json#defaultMode', 'approval-policy');
    expect(approval.observed.native.kind).toBe('approval-policy');
    expect(approval.observed.metadata).toEqual({ approvalPolicy: 'acceptEdits' });

    // Hooks expose matcher patterns; the command strings never leave the adapter.
    const hooks = await show('project', '.claude/settings.json#hooks', 'hooks');
    expect(hooks.observed.metadata).toMatchObject({
      eventNames: ['SessionStart', 'PreToolUse'],
      hookMatchers: ['startup|resume|compact', 'Bash'],
      hookMatcherCount: 2,
    });

    // A plugin is a `plugin` element; the elements it supplies keep their own kind.
    const plugin = await show('plugin', '~/.claude/plugins/market/plug/plugin.json', 'plugin');
    expect(plugin.observed.native.kind).toBe('plugin');
    expect(plugin.resolved).toMatchObject({
      status: 'effective',
      applicability: { type: 'global' },
      resolution: { strategy: 'available' },
    });
    const pluginSkill = await show(
      'plugin',
      '~/.claude/plugins/market/plug/skills/x/SKILL.md',
      'skills',
    );
    expect(pluginSkill.observed.native.kind).toBe('skills');
    const pluginAgent = await show(
      'plugin',
      '~/.claude/plugins/market/plug/agents/reviewer.md',
      'subagents',
    );
    expect(pluginAgent.observed.native.kind).toBe('subagents');

    // The CLAUDE.md tree: the same-directory local file shadows the base, the
    // nested file governs its subtree, and the parent read is global.
    const root = await show('project', 'CLAUDE.md', 'instructions');
    expect(root.resolved).toMatchObject({ status: 'shadowed', applicability: { type: 'project' } });
    expect((await show('project', 'CLAUDE.local.md', 'instructions')).resolved.status).toBe(
      'effective',
    );
    expect((await show('project', 'docs/CLAUDE.md', 'instructions')).resolved).toMatchObject({
      status: 'effective',
      applicability: { type: 'directory-subtree', target: 'docs' },
    });
    expect((await show('project', '../CLAUDE.md', 'instructions')).resolved.applicability).toEqual({
      type: 'global',
    });
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

  it('emits exactly one JSON document on stdout and sends logs to stderr', async () => {
    const m = await fixture();
    await runCli(m, ['inspect', '--runtime', 'claude-code']);

    const result = await runCli(m, ['report', '--json']);

    expect(result.code).toBe(EXIT_CODES.SUCCESS);
    // A single JSON.parse over the whole stdout proves there is one document.
    const document = JSON.parse(result.stdout) as {
      pflVersion: string;
      command: string;
      ok: boolean;
      completeness: string;
      diagnostics: unknown[];
      data: unknown;
    };
    expect(document).toMatchObject({ command: 'report', ok: true });
    expect(document.pflVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(document.completeness).toBe('partial');
    expect(Array.isArray(document.diagnostics)).toBe(true);
    expect(document.data).toBeTypeOf('object');
  });

  it('stores the interpretation and reads the stored payload back', async () => {
    const m = await fixture();
    await runCli(m, ['inspect', '--runtime', 'claude-code']);
    const projectId = (await resolveProjectContext(m.projectRoot)).id;
    const pointer = await readLatestPointer(projectId, m.home);
    if (pointer?.interpretation === undefined) throw new Error('expected an interpretation id');
    const artifact = join(interpretationsDir(projectId, m.home), `${pointer.interpretation}.json`);

    // Mutate the stored classifier version: the report must return the stored
    // value, which proves it read the artifact rather than recomputing.
    const raw = JSON.parse(await readFile(artifact, 'utf8')) as {
      classifier: { version: string };
    };
    raw.classifier.version = '999';
    await writeFile(artifact, `${JSON.stringify(raw)}\n`);

    const stored = JSON.parse((await runCli(m, ['report', '--json'])).stdout) as {
      data: { interpretation: { classifierVersion: string; origin: string } };
    };
    expect(stored.data.interpretation).toEqual({ classifierVersion: '999', origin: 'stored' });
  });

  it('recomputes when no interpretation is stored, and fails closed when it is corrupt', async () => {
    const m = await fixture();
    await runCli(m, ['inspect', '--runtime', 'claude-code']);
    const projectId = (await resolveProjectContext(m.projectRoot)).id;
    const pointer = await readLatestPointer(projectId, m.home);
    if (pointer?.interpretation === undefined) throw new Error('expected an interpretation id');
    const artifact = join(interpretationsDir(projectId, m.home), `${pointer.interpretation}.json`);

    // Absence (a pre-v1.0 run) is not an error: the report recomputes and says so.
    await rm(artifact);
    const human = await runCli(m, ['report']);
    expect(human.code, human.stderr).toBe(EXIT_CODES.SUCCESS);
    expect(human.stdout).toContain('Interpretation recomputed');
    const recomputed = JSON.parse((await runCli(m, ['report', '--json'])).stdout) as {
      data: { interpretation: { origin: string } };
    };
    expect(recomputed.data.interpretation.origin).toBe('recomputed');

    // A corrupt stored interpretation is not absence: it fails closed with a
    // diagnostic, rather than masking store corruption with a recomputation.
    await writeFile(artifact, '{ not json');
    const corrupt = await runCli(m, ['report', '--json']);
    expect(corrupt.code).toBe(EXIT_CODES.CONFIG_ERROR);
    const document = JSON.parse(corrupt.stdout) as {
      data: { error: { code: string } };
      diagnostics: { code: string }[];
    };
    expect(document.data.error.code).toBe('CONFIG_ERROR');
    expect(document.diagnostics[0]?.code).toBe('invalid-snapshot');
  });

  it('emits the failure envelope on a non-zero exit', async () => {
    const m = await fixture();

    // No snapshot is stored, so report fails with a configuration error.
    const result = await runCli(m, ['report', '--json']);

    expect(result.code).toBe(EXIT_CODES.CONFIG_ERROR);
    const document = JSON.parse(result.stdout) as {
      command: string;
      ok: boolean;
      data: { error: { code: string; message: string } };
    };
    expect(document.command).toBe('report');
    expect(document.ok).toBe(false);
    expect(document.data.error.code).toBe('CONFIG_ERROR');
  });

  it('emits the failure envelope for a parser error, not a stack trace', async () => {
    const m = await fixture();

    // An unknown option is rejected by `cac` before the action runs.
    const unknownOption = await runCli(m, ['report', '--json', '--bogus']);
    expect(unknownOption.code).toBe(EXIT_CODES.CONFIG_ERROR);
    const unknownDocument = JSON.parse(unknownOption.stdout) as {
      command: string;
      ok: boolean;
      data: { error: { code: string; message: string } };
    };
    expect(unknownDocument).toMatchObject({ command: 'report', ok: false });
    expect(unknownDocument.data.error.code).toBe('CONFIG_ERROR');
    expect(unknownOption.stderr).not.toContain('CACError');

    // A missing required positional is also rejected before the action.
    const missingArg = await runCli(m, ['show', '--json']);
    expect(missingArg.code).toBe(EXIT_CODES.CONFIG_ERROR);
    expect(JSON.parse(missingArg.stdout)).toMatchObject({
      command: 'show',
      ok: false,
      data: { error: { code: 'CONFIG_ERROR' } },
    });
    expect(missingArg.stderr).not.toContain('CACError');
  });

  it('rejects an unknown command and shows help when no command is given', async () => {
    const m = await fixture();

    const unknown = await runCli(m, ['bogus', '--json']);
    expect(unknown.code).toBe(EXIT_CODES.CONFIG_ERROR);
    const unknownDocument = JSON.parse(unknown.stdout) as {
      command: string;
      ok: boolean;
      data: { error: { code: string } };
    };
    expect(unknownDocument).toMatchObject({ command: 'pfl', ok: false });
    expect(unknownDocument.data.error.code).toBe('CONFIG_ERROR');

    // `--json` with nothing to document is still a failure document.
    const noCommandJson = await runCli(m, ['--json']);
    expect(noCommandJson.code).toBe(EXIT_CODES.CONFIG_ERROR);
    expect(JSON.parse(noCommandJson.stdout)).toMatchObject({ ok: false });

    // No command at all is help, not a silent exit.
    const noCommand = await runCli(m, []);
    expect(noCommand.code).toBe(EXIT_CODES.SUCCESS);
    expect(noCommand.stdout).toContain('Usage');
  });

  it('degrades an unsupported snapshot schema to a diagnostic, not exit 6', async () => {
    const m = await fixture();
    await runCli(m, ['inspect', '--runtime', 'claude-code']);
    const projectId = (await resolveProjectContext(m.projectRoot)).id;
    const pointer = await readLatestPointer(projectId, m.home);
    if (pointer === null) throw new Error('expected a latest pointer after inspect');
    const artifact = join(snapshotsDir(projectId, m.home), `${pointer.resolved}.json`);
    const raw = JSON.parse(await readFile(artifact, 'utf8')) as Record<string, unknown>;
    await writeFile(artifact, `${JSON.stringify({ ...raw, schemaVersion: '2' })}\n`);

    // `report` defaults to latest, which now points at a schema-2 snapshot.
    const result = await runCli(m, ['report', '--json']);

    expect(result.code).toBe(EXIT_CODES.CONFIG_ERROR);
    const document = JSON.parse(result.stdout) as {
      ok: boolean;
      data: { error: { code: string; message: string } };
      diagnostics: { code: string; message: string }[];
    };
    expect(document.ok).toBe(false);
    expect(document.data.error.code).toBe('CONFIG_ERROR');
    expect(document.diagnostics[0]?.code).toBe('unsupported-snapshot-schema');
    expect(document.diagnostics[0]?.message).toContain('2');
  });

  it('emits the missing consent scopes in the failure document', async () => {
    const m = await materialize('claude');
    materialized.push(m);

    const result = await runCli(m, ['inspect', '--runtime', 'claude-code', '--json']);

    expect(result.code).toBe(EXIT_CODES.CONSENT_REQUIRED);
    const document = JSON.parse(result.stdout) as {
      ok: boolean;
      data: { error: { code: string }; missingScopes?: string[] };
    };
    expect(document.ok).toBe(false);
    expect(document.data.error.code).toBe('CONSENT_REQUIRED');
    expect(document.data.missingScopes).toContain('claude-code:user');
  });
});
