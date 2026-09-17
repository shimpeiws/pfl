import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ObservedElement } from '../../core/observed.js';
import { MAX_PARSE_BYTES } from '../../limits.js';
import { collectCodexHarness } from './discovery.js';
import { userConfigDir } from './paths.js';

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const CONSENTED = { allowOutsideProject: true, grantedScopes: ['codex:user'] };
const DENIED = { allowOutsideProject: false, grantedScopes: [] };

interface Fixture {
  project: { id: string; displayName: string; root: string; remote: string };
  home: string;
}

async function makeFixture(): Promise<Fixture> {
  const base = await tempDir('pfl-codex-');
  const root = join(base, 'project');
  const home = join(base, 'home');
  const outside = join(base, 'outside');
  const configDir = userConfigDir(home);

  await mkdir(root, { recursive: true });
  await mkdir(join(configDir, 'skills'), { recursive: true });
  await mkdir(join(configDir, 'agents'), { recursive: true });
  await mkdir(join(configDir, 'rules'), { recursive: true });
  await mkdir(join(configDir, 'memories'), { recursive: true });
  await mkdir(
    join(configDir, 'packages', 'standalone', 'releases', '0.154.0-aarch64-apple-darwin'),
    {
      recursive: true,
    },
  );
  await mkdir(outside, { recursive: true });

  await writeFile(join(root, 'AGENTS.md'), '# Project agents\n');
  await writeFile(join(root, 'AGENTS.override.md'), '# Project override\n');
  await writeFile(join(configDir, 'AGENTS.md'), '# User agents\n');
  await writeFile(
    join(configDir, 'config.toml'),
    [
      '# Codex user config',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      'model = "gpt-5.6-luna"',
      'model_reasoning_effort = "medium"',
      'notify = ["/bin/notify", "turn-ended"]',
      '[mcp_servers.node_repl]',
      'command = "node"',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(configDir, 'hooks.json'),
    JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [] }] } }),
  );
  await writeFile(
    join(configDir, 'skills', 'SKILL.md'),
    [
      '---',
      'name: tool',
      'description: "A Codex skill"',
      'allowed-tools: Read, Write',
      '---',
      '# Skill',
      '',
    ].join('\n'),
  );
  await writeFile(join(configDir, 'agents', 'reviewer.md'), '# Reviewer\n');
  await writeFile(join(configDir, 'rules', 'rule.md'), '# Rule\n');
  await writeFile(join(configDir, 'memories', 'MEMORY.md'), '# Memory\n');
  await writeFile(join(outside, 'leaked.txt'), 'must not be discovered\n');
  await symlink(join('..', '..', '..', 'outside'), join(configDir, 'skills', 'link'));

  return {
    project: { id: 'proj', displayName: 'owner/repo', root, remote: 'github.com/owner/repo' },
    home,
  };
}

function byPath(elements: readonly ObservedElement[]): Map<string, ObservedElement> {
  return new Map(elements.map((element) => [element.source.path ?? '', element]));
}

describe('collectCodexHarness', () => {
  it('discovers project and user elements when consent is granted', async () => {
    const { project, home } = await makeFixture();

    const snapshot = await collectCodexHarness(project, CONSENTED, home);
    const paths = byPath(snapshot.elements);

    expect(paths.get('AGENTS.md')?.native.kind).toBe('instructions');
    expect(paths.get('AGENTS.override.md')?.native.kind).toBe('fallback-instructions');
    expect(paths.get('~/.codex/AGENTS.md')?.native.kind).toBe('instructions');
    expect(paths.get('~/.codex/skills/SKILL.md')?.native.kind).toBe('skills');
    expect(paths.get('~/.codex/agents/reviewer.md')?.native.kind).toBe('custom-agents');
    expect(paths.get('~/.codex/rules/rule.md')?.native.kind).toBe('permissions');
    expect(paths.get('~/.codex/memories/MEMORY.md')?.native.kind).toBe('memory');
  });

  it('extracts config.toml structure without applying or persisting secrets', async () => {
    const { project, home } = await makeFixture();

    const snapshot = await collectCodexHarness(project, CONSENTED, home);
    const paths = byPath(snapshot.elements);

    expect(paths.get('~/.codex/config.toml#approval')?.metadata).toEqual({
      approvalMode: 'on-request',
      sandboxMode: 'workspace-write',
    });
    expect(paths.get('~/.codex/config.toml#context')?.metadata).toEqual({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'medium',
    });
    expect(paths.get('~/.codex/config.toml#mcp_servers')?.metadata).toEqual({
      serverNames: ['node_repl'],
    });
    expect(paths.get('~/.codex/hooks.json#hooks')?.metadata).toEqual({
      eventNames: ['SessionStart'],
    });
  });

  it('resolves frontmatter structure for walked skill files', async () => {
    const { project, home } = await makeFixture();

    const snapshot = await collectCodexHarness(project, CONSENTED, home);
    const element = byPath(snapshot.elements).get('~/.codex/skills/SKILL.md');

    expect(element?.metadata).toEqual({
      format: 'md',
      hasFrontmatter: true,
      frontmatterKeys: ['name', 'description', 'allowed-tools'],
      descriptionLength: 'A Codex skill'.length,
      toolNames: ['Read', 'Write'],
    });
    expect(JSON.stringify(snapshot.elements)).not.toContain('A Codex skill');
  });

  it('does not open user scope when consent is denied', async () => {
    const { project, home } = await makeFixture();

    const snapshot = await collectCodexHarness(project, DENIED, home);

    expect(snapshot.elements.some((element) => element.native.origin === 'user')).toBe(false);
    expect(snapshot.runtime.version).toBeNull();
    expect(snapshot.adapter.runtimeCompatibility).toBe('unverified');
    expect(snapshot.diagnostics.map((entry) => entry.code)).toContain('consent-not-granted');
  });

  it('reports the detected runtime version when consented', async () => {
    const { project, home } = await makeFixture();

    const snapshot = await collectCodexHarness(project, CONSENTED, home);

    expect(snapshot.runtime.version).toBe('0.154.0');
    expect(snapshot.adapter.runtimeCompatibility).toBe('verified');
  });

  it('records a symlink as skipped and never follows it', async () => {
    const { project, home } = await makeFixture();

    const snapshot = await collectCodexHarness(project, CONSENTED, home);
    const link = byPath(snapshot.elements).get('~/.codex/skills/link');

    expect(link).toMatchObject({ status: 'skipped', reason: 'symlink-not-followed' });
    expect(
      snapshot.elements.some((element) => (element.source.path ?? '').includes('leaked')),
    ).toBe(false);
  });

  it('records the built-in instruction layer as opaque', async () => {
    const { project, home } = await makeFixture();

    const snapshot = await collectCodexHarness(project, CONSENTED, home);
    const opaque = snapshot.elements.filter((element) => element.inspectability === 'opaque');

    expect(opaque).toHaveLength(1);
    expect(opaque[0]?.native.origin).toBe('builtin');
    expect(snapshot.completeness).toBe('partial');
  });
});

describe('collectCodexHarness symlinked settings (S1)', () => {
  interface SymlinkFixture {
    project: { id: string; displayName: string; root: string; remote: string };
    home: string;
  }

  async function makeSymlinkFixture(): Promise<SymlinkFixture> {
    const base = await tempDir('pfl-codex-symlink-');
    const root = join(base, 'project');
    const home = join(base, 'home');
    const outside = join(base, 'outside');

    await mkdir(root, { recursive: true });
    await mkdir(userConfigDir(home), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(
      join(outside, 'secret-config.toml'),
      'approval_policy = "never"\ntoken = "sk-ant-should-not-be-read"\n',
    );
    await writeFile(
      join(outside, 'secret-hooks.json'),
      JSON.stringify({ hooks: { SessionStart: [{ matcher: 'LEAKED_HOOK_MATCHER' }] } }),
    );

    await symlink(
      join('..', '..', 'outside', 'secret-config.toml'),
      join(userConfigDir(home), 'config.toml'),
    );
    await symlink(
      join('..', '..', 'outside', 'secret-hooks.json'),
      join(userConfigDir(home), 'hooks.json'),
    );

    return {
      project: { id: 'proj', displayName: 'owner/repo', root, remote: 'github.com/owner/repo' },
      home,
    };
  }

  it('records symlinked config.toml and hooks.json as skipped and never parses them', async () => {
    const { project, home } = await makeSymlinkFixture();

    const snapshot = await collectCodexHarness(project, CONSENTED, home);
    const paths = byPath(snapshot.elements);

    for (const path of ['~/.codex/config.toml', '~/.codex/hooks.json']) {
      expect(paths.get(path)).toMatchObject({
        status: 'skipped',
        reason: 'symlink-not-followed',
      });
    }
    // The old, unguarded read parsed the targets and emitted these config elements.
    expect(paths.has('~/.codex/config.toml#approval')).toBe(false);
    expect(paths.has('~/.codex/hooks.json#hooks')).toBe(false);
    expect(JSON.stringify(snapshot.elements)).not.toContain('sk-ant-should-not-be-read');
    expect(JSON.stringify(snapshot.elements)).not.toContain('LEAKED_HOOK_MATCHER');
  });

  it('skips a config.toml over MAX_PARSE_BYTES before parsing it', async () => {
    const base = await tempDir('pfl-codex-large-');
    const root = join(base, 'project');
    const home = join(base, 'home');
    await mkdir(root, { recursive: true });
    await mkdir(userConfigDir(home), { recursive: true });
    await writeFile(
      join(userConfigDir(home), 'config.toml'),
      `approval_policy = "never"\n# ${'x'.repeat(MAX_PARSE_BYTES)}`,
    );

    const snapshot = await collectCodexHarness(
      { id: 'proj', displayName: 'owner/repo', root, remote: 'github.com/owner/repo' },
      CONSENTED,
      home,
    );
    const paths = byPath(snapshot.elements);

    expect(paths.get('~/.codex/config.toml')).toMatchObject({
      status: 'skipped',
      reason: 'limit-exceeded',
    });
    expect(paths.has('~/.codex/config.toml#approval')).toBe(false);
    expect(
      snapshot.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'limit-exceeded' && diagnostic.message.includes('MAX_PARSE_BYTES'),
      ),
    ).toBe(true);
  });
});
