import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ObservedElement } from '../../core/observed.js';
import { MAX_ANCESTOR_DIRS, MAX_PARSE_BYTES } from '../../limits.js';
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
  await mkdir(join(root, '.codex', 'skills', 'project-skill'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(configDir, 'skills'), { recursive: true });
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
  await writeFile(join(root, 'docs', 'AGENTS.md'), '# Nested docs agents\n');
  await writeFile(
    join(root, '.codex', 'skills', 'project-skill', 'SKILL.md'),
    [
      '---',
      'name: project-tool',
      'description: "A project-scoped Codex skill"',
      '---',
      '# Project skill',
      '',
    ].join('\n'),
  );
  // The project's parent directory (the fixture base) carries instruction files,
  // which are out-of-project reads.
  await writeFile(join(base, 'AGENTS.md'), '# Parent agents\n');
  await writeFile(join(base, 'AGENTS.override.md'), '# Parent override\n');
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
      'command = "SENTINEL_CODEX_MCP_COMMAND"',
      'args = ["token=SENTINEL_CODEX_MCP_ARG"]',
      '[sandbox_workspace_write]',
      'network_access = true',
      'writable_roots = ["/first", "/second"]',
      '[shell_environment_policy]',
      'inherit = "core"',
      '[shell_environment_policy.set]',
      'FOO = "SENTINEL_ENV_VALUE"',
      'BAZ = "SENTINEL_ENV_VALUE_2"',
      `[projects."${root}"]`,
      'trust_level = "trusted"',
      '[marketplaces.local]',
      'source_type = "local"',
      '[plugins."browser@local"]',
      'enabled = true',
      '[plugins."off@local"]',
      'enabled = false',
      '[profiles.fast]',
      'approval_policy = "never"',
      '[features]',
      'hooks = true',
      '[hooks.state."x"]',
      'last_run = 1',
      '[tui.model_availability_nux]',
      '"gpt" = 1',
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
    expect(paths.get('~/.codex/rules/rule.md')?.native.kind).toBe('permissions');
    expect(paths.get('~/.codex/memories/MEMORY.md')?.native.kind).toBe('memory');
  });

  it('discovers project-scoped skills and nested and parent AGENTS.md', async () => {
    const { project, home } = await makeFixture();

    const snapshot = await collectCodexHarness(project, CONSENTED, home);
    const paths = byPath(snapshot.elements);

    expect(paths.get('.codex/skills/project-skill/SKILL.md')).toMatchObject({
      native: { kind: 'skills', origin: 'project', scope: 'project' },
      metadata: { hasFrontmatter: true, frontmatterKeys: ['name', 'description'] },
    });
    expect(paths.get('docs/AGENTS.md')?.native.kind).toBe('instructions');
    // `dirname(root)` is the fixture base, one level above the project.
    expect(paths.get('../AGENTS.md')?.native.kind).toBe('instructions');
    expect(paths.get('../AGENTS.override.md')?.native.kind).toBe('fallback-instructions');
  });

  it('records each discovered file once, with unique element ids', async () => {
    const { project, home } = await makeFixture();

    const snapshot = await collectCodexHarness(project, CONSENTED, home);
    const ids = snapshot.elements.map((element) => element.id);
    const projectPaths = snapshot.elements
      .map((element) => element.source.path)
      .filter((path): path is string => path !== undefined);

    // A second root-file loop would mint a duplicate id for AGENTS.md.
    expect(new Set(ids).size).toBe(ids.length);
    expect(projectPaths.filter((path) => path === 'AGENTS.md')).toHaveLength(1);
    expect(projectPaths.filter((path) => path === 'AGENTS.override.md')).toHaveLength(1);
  });

  it('does not exclude a nested directory that shares the project config name', async () => {
    const { project, home } = await makeFixture();
    await mkdir(join(project.root, 'docs', '.codex'), { recursive: true });
    await writeFile(
      join(project.root, 'docs', '.codex', 'AGENTS.md'),
      '# Nested config-name dir\n',
    );

    const snapshot = await collectCodexHarness(project, CONSENTED, home);

    // Only `<root>/.codex` is the config directory; a nested `.codex` must not be
    // pruned, so its instruction file is still discovered.
    expect(byPath(snapshot.elements).get('docs/.codex/AGENTS.md')?.native.kind).toBe(
      'instructions',
    );
  });

  it('does not double-record an AGENTS.md inside the project skills area', async () => {
    const { project, home } = await makeFixture();
    await writeFile(
      join(project.root, '.codex', 'skills', 'project-skill', 'AGENTS.md'),
      '# A skill file that happens to be named AGENTS.md\n',
    );

    const snapshot = await collectCodexHarness(project, CONSENTED, home);
    const ids = snapshot.elements.map((element) => element.id);
    const matches = snapshot.elements.filter(
      (element) => element.source.path === '.codex/skills/project-skill/AGENTS.md',
    );

    // Without the path-aware exclusion the instruction walk records it a second
    // time under the same id.
    expect(new Set(ids).size).toBe(ids.length);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.native.kind).toBe('skills');
  });

  it('does not read parent directories when consent is denied', async () => {
    const { project, home } = await makeFixture();

    const snapshot = await collectCodexHarness(project, DENIED, home);

    expect(snapshot.elements.some((element) => (element.source.path ?? '').startsWith('../'))).toBe(
      false,
    );
  });

  it('bounds the upward walk at MAX_ANCESTOR_DIRS and records the truncation', async () => {
    const base = await tempDir('pfl-codex-deep-');
    let root = base;
    for (let level = 0; level <= MAX_ANCESTOR_DIRS; level += 1) {
      root = join(root, `d${level}`);
    }
    await mkdir(root, { recursive: true });
    await mkdir(userConfigDir(join(base, 'home')), { recursive: true });
    // `base` is `MAX_ANCESTOR_DIRS + 1` levels above the root, so it is beyond
    // the ceiling and must not be read.
    await writeFile(join(base, 'AGENTS.md'), '# Out of reach\n');

    const snapshot = await collectCodexHarness(
      { id: 'proj', displayName: 'owner/repo', root, remote: 'github.com/owner/repo' },
      CONSENTED,
      join(base, 'home'),
    );

    expect(
      snapshot.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'limit-exceeded' && diagnostic.message.includes('MAX_ANCESTOR_DIRS'),
      ),
    ).toBe(true);
    expect(
      snapshot.elements.some(
        (element) =>
          element.native.kind === 'instructions' &&
          (element.source.path ?? '').startsWith('../'.repeat(MAX_ANCESTOR_DIRS + 1)),
      ),
    ).toBe(false);
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
    expect(paths.get('~/.codex/config.toml#sandbox_workspace_write')?.metadata).toEqual({
      networkAccess: true,
      writableRootCount: 2,
    });
    expect(paths.get('~/.codex/config.toml#shell_environment_policy')?.metadata).toEqual({
      inheritMode: 'core',
      setKeyCount: 2,
    });
    expect(paths.get('~/.codex/config.toml#plugins')?.metadata).toEqual({
      pluginNames: ['browser@local', 'off@local'],
      enabledPluginCount: 1,
    });
    expect(paths.get('~/.codex/config.toml#marketplaces')?.metadata).toEqual({
      marketplaceNames: ['local'],
    });
    expect(paths.get(`~/.codex/config.toml#profiles.fast`)?.metadata).toEqual({
      approvalMode: 'never',
    });
    expect(paths.get(`~/.codex/config.toml#projects.${project.root}`)).toMatchObject({
      native: { kind: 'project-configuration', origin: 'user', scope: 'project' },
      metadata: { trustLevel: 'trusted' },
    });
    // A secret-shaped environment value in `[shell_environment_policy.set]` is
    // never persisted, only counted.
    expect(JSON.stringify(snapshot.elements)).not.toContain('SENTINEL_ENV_VALUE');
    // MCP command/args are deliberately not persisted, only server names.
    expect(JSON.stringify(snapshot.elements)).not.toContain('SENTINEL_CODEX_MCP_COMMAND');
    expect(JSON.stringify(snapshot.elements)).not.toContain('SENTINEL_CODEX_MCP_ARG');
    expect(paths.get('~/.codex/hooks.json#hooks')?.metadata).toEqual({
      eventNames: ['SessionStart'],
    });
  });

  it('records unmodelled config.toml sections as unsupported rather than dropping them', async () => {
    const { project, home } = await makeFixture();

    const snapshot = await collectCodexHarness(project, CONSENTED, home);
    const paths = byPath(snapshot.elements);

    for (const section of ['features', 'hooks', 'tui']) {
      expect(paths.get(`~/.codex/config.toml#${section}`)).toMatchObject({
        status: 'unsupported',
        reason: 'unsupported-by-adapter',
        native: { kind: 'unknown' },
      });
    }
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
