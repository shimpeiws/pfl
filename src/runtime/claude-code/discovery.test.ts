import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ObservedElement } from '../../core/observed.js';
import { encodeProjectDir, userConfigDir } from './paths.js';
import { collectClaudeCodeHarness } from './discovery.js';

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const CONSENTED = { allowOutsideProject: true, grantedScopes: ['claude-code:user'] };
const DENIED = { allowOutsideProject: false, grantedScopes: [] };

interface Fixture {
  project: { id: string; displayName: string; root: string; remote: string };
  home: string;
}

async function makeFixture(): Promise<Fixture> {
  const base = await tempDir('pfl-claude-');
  const root = join(base, 'project');
  const home = join(base, 'home');
  const outside = join(base, 'outside');

  await mkdir(join(root, '.claude', 'skills', 'foo'), { recursive: true });
  await mkdir(join(root, '.claude', 'agents'), { recursive: true });
  await mkdir(join(root, '.claude', 'commands'), { recursive: true });
  await mkdir(join(root, '.claude', 'rules'), { recursive: true });
  await mkdir(join(root, '.claude', 'output-styles'), { recursive: true });
  await mkdir(join(root, '.claude', 'hooks'), { recursive: true });
  await mkdir(outside, { recursive: true });

  await writeFile(join(root, 'CLAUDE.md'), '# Project instructions SENTINEL_PROJECT\n');
  await writeFile(
    join(root, '.claude', 'settings.json'),
    JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'], deny: [], ask: [] },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
      outputStyle: 'terse',
      mcpServers: { github: { command: 'npx' } },
      enabledPlugins: { 'pkg@market': true },
      secretToken: 'sk-ant-should-not-persist',
    }),
  );
  await writeFile(join(root, '.claude', 'skills', 'foo', 'SKILL.md'), '# Foo skill\n');
  await writeFile(join(root, '.claude', 'agents', 'reviewer.md'), '# Reviewer\n');
  await writeFile(join(root, '.claude', 'commands', 'deploy.md'), '# Deploy\n');
  await writeFile(join(root, '.claude', 'rules', 'rule.md'), '# Rule\n');
  await writeFile(join(root, '.claude', 'output-styles', 'terse.md'), '# Terse\n');
  await writeFile(join(root, '.claude', 'hooks', 'pre.sh'), 'echo hook\n');
  await writeFile(join(root, '.claude', 'unknown.xyz'), 'unknown element\n');
  await writeFile(join(outside, 'leaked.txt'), 'must not be discovered\n');
  await symlink(join('..', '..', 'outside'), join(root, '.claude', 'link'));
  await writeFile(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { project: {} } }));

  await mkdir(join(userConfigDir(home), 'skills', 'bar'), { recursive: true });
  await mkdir(join(userConfigDir(home), 'plugins', 'market', 'plug', 'skills', 'x'), {
    recursive: true,
  });
  await mkdir(join(userConfigDir(home), 'projects', encodeProjectDir(root), 'memory'), {
    recursive: true,
  });
  await writeFile(join(userConfigDir(home), 'CLAUDE.md'), '# User instructions\n');
  await writeFile(join(userConfigDir(home), 'settings.json'), JSON.stringify({ model: 'opus' }));
  await writeFile(join(userConfigDir(home), 'skills', 'bar', 'SKILL.md'), '# Bar skill\n');
  await writeFile(
    join(userConfigDir(home), 'plugins', 'market', 'plug', 'skills', 'x', 'SKILL.md'),
    '# Plugin skill\n',
  );
  await writeFile(join(userConfigDir(home), 'plugins', 'market', 'plug', 'plugin.json'), '{}');
  await writeFile(
    join(userConfigDir(home), 'projects', encodeProjectDir(root), 'memory', 'MEMORY.md'),
    '# Memory\n',
  );
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: { user: {} } }));
  await mkdir(join(home, '.local', 'share', 'claude', 'versions'), { recursive: true });
  await writeFile(join(home, '.local', 'share', 'claude', 'versions', '2.1.100'), '');

  return {
    project: { id: 'proj', displayName: 'owner/repo', root, remote: 'github.com/owner/repo' },
    home,
  };
}

function byPath(elements: ObservedElement[]): Map<string, ObservedElement> {
  return new Map(elements.map((element) => [element.source.path ?? '', element]));
}

describe('collectClaudeCodeHarness', () => {
  it('discovers project and user elements when consent is granted', async () => {
    const { project, home } = await makeFixture();

    const snapshot = await collectClaudeCodeHarness(project, CONSENTED, home);
    const paths = byPath(snapshot.elements);

    expect(paths.get('CLAUDE.md')?.native.kind).toBe('instructions');
    expect(paths.get('.claude/skills/foo/SKILL.md')?.native.kind).toBe('skills');
    expect(paths.get('.claude/agents/reviewer.md')?.native.kind).toBe('subagents');
    expect(paths.get('.claude/commands/deploy.md')?.native.kind).toBe('commands');
    expect(paths.get('.mcp.json')?.native.kind).toBe('mcp-configuration');
    expect(paths.get('~/.claude/CLAUDE.md')?.native.origin).toBe('user');
    expect(paths.get('~/.claude/skills/bar/SKILL.md')?.native.kind).toBe('skills');
    expect(
      paths.get('~/.claude/projects/' + encodeProjectDir(project.root) + '/memory/MEMORY.md')
        ?.native.kind,
    ).toBe('memory');
    expect(paths.get('CLAUDE.md')?.source.digest).toMatch(/^sha256:/);
    const pluginSkill = paths.get('~/.claude/plugins/market/plug/skills/x/SKILL.md');
    expect(pluginSkill?.native.origin).toBe('plugin');
    expect(pluginSkill?.native.kind).toBe('skills');
  });

  it('does not open user scope when consent is denied', async () => {
    const { project, home } = await makeFixture();

    const snapshot = await collectClaudeCodeHarness(project, DENIED, home);

    expect(snapshot.elements.some((element) => element.native.origin === 'user')).toBe(false);
    expect(snapshot.elements.some((element) => element.native.origin === 'plugin')).toBe(false);
    expect(
      snapshot.elements.some((element) => (element.source.path ?? '').includes('~/.claude')),
    ).toBe(false);
    expect(snapshot.runtime.version).toBeNull();
    expect(snapshot.adapter.runtimeCompatibility).toBe('unverified');
  });

  it('reports the detected runtime version when consented', async () => {
    const { project, home } = await makeFixture();

    const snapshot = await collectClaudeCodeHarness(project, CONSENTED, home);

    expect(snapshot.runtime.version).toBe('2.1.100');
    expect(snapshot.adapter.runtimeCompatibility).toBe('verified');
  });

  it('records a symlink as skipped and never follows it', async () => {
    const { project, home } = await makeFixture();

    const snapshot = await collectClaudeCodeHarness(project, CONSENTED, home);
    const paths = byPath(snapshot.elements);

    const link = [...paths.values()].find((element) => element.source.path === '.claude/link');
    expect(link).toMatchObject({ status: 'skipped', reason: 'symlink-not-followed' });
    expect(
      snapshot.elements.some((element) => (element.source.path ?? '').includes('leaked')),
    ).toBe(false);
  });

  it('preserves an unknown file inside a known area as unsupported', async () => {
    const { project, home } = await makeFixture();

    const snapshot = await collectClaudeCodeHarness(project, CONSENTED, home);
    const unknown = byPath(snapshot.elements).get('.claude/unknown.xyz');

    expect(unknown).toMatchObject({ status: 'unsupported', reason: 'unsupported-by-adapter' });
    expect(unknown?.native.kind).toBe('unknown');
  });

  it('extracts settings structure without persisting raw values', async () => {
    const { project, home } = await makeFixture();

    const snapshot = await collectClaudeCodeHarness(project, CONSENTED, home);
    const paths = byPath(snapshot.elements);

    expect(paths.get('.claude/settings.json#permissions')?.metadata).toEqual({
      allowCount: 1,
      denyCount: 0,
      askCount: 0,
    });
    expect(paths.get('.claude/settings.json#hooks')?.metadata).toEqual({
      eventNames: ['SessionStart'],
    });
    expect(paths.get('.claude/settings.json#outputStyle')?.metadata).toEqual({
      outputStyle: 'terse',
    });
    expect(paths.get('.claude/settings.json#mcpServers')?.metadata).toEqual({
      serverNames: ['github'],
    });
    expect(paths.get('.claude/settings.json#enabledPlugins')?.metadata).toEqual({
      enabledPluginCount: 1,
    });
    expect(JSON.stringify(snapshot.elements)).not.toContain('sk-ant-should-not-persist');
  });

  it('records the built-in instruction layer as opaque', async () => {
    const { project, home } = await makeFixture();

    const snapshot = await collectClaudeCodeHarness(project, CONSENTED, home);
    const opaque = snapshot.elements.filter((element) => element.inspectability === 'opaque');

    expect(opaque).toHaveLength(1);
    expect(opaque[0]?.native.kind).toBe('runtime-provided-instructions');
    expect(opaque[0]?.native.origin).toBe('builtin');
  });

  it('is partial because of the symlink and the unknown element', async () => {
    const { project, home } = await makeFixture();

    const snapshot = await collectClaudeCodeHarness(project, CONSENTED, home);

    expect(snapshot.completeness).toBe('partial');
  });
});
