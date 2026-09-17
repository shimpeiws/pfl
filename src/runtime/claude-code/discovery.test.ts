import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { deriveFindings } from '../../classify/findings.js';
import type { ObservedElement } from '../../core/observed.js';
import { MAX_ANCESTOR_DIRS } from '../../limits.js';
import { MANAGED_CONFIG_DIR, encodeProjectDir, userConfigDir } from './paths.js';
import { collectClaudeCodeHarness, managedConfigDirFor } from './discovery.js';
import { resolveClaudeCode } from './resolve.js';

const originalPath = process.env['PATH'];

// Detection scans `PATH` for an install the installer does not manage. These
// tests inject a home, so `PATH` is emptied too: the machine's own installs are
// never read and a version assertion cannot depend on the host.
beforeAll(() => {
  process.env['PATH'] = '';
});
afterAll(() => {
  process.env['PATH'] = originalPath;
});

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
  managed: string;
}

async function makeFixture(): Promise<Fixture> {
  const base = await tempDir('pfl-claude-');
  const root = join(base, 'project');
  const home = join(base, 'home');
  const outside = join(base, 'outside');
  const managed = join(base, 'managed');

  await mkdir(join(root, '.claude', 'skills', 'foo'), { recursive: true });
  await mkdir(join(root, '.claude', 'agents'), { recursive: true });
  await mkdir(join(root, '.claude', 'commands'), { recursive: true });
  await mkdir(join(root, '.claude', 'rules'), { recursive: true });
  await mkdir(join(root, '.claude', 'output-styles'), { recursive: true });
  await mkdir(join(root, '.claude', 'hooks'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(managed, { recursive: true });

  await writeFile(join(root, 'CLAUDE.md'), '# Project instructions SENTINEL_PROJECT\n');
  await writeFile(join(root, 'CLAUDE.local.md'), '# Project local instructions SENTINEL_LOCAL\n');
  await writeFile(join(root, 'docs', 'CLAUDE.md'), '# Nested instructions SENTINEL_NESTED\n');
  // The project's parent directory (the fixture base) carries instruction files,
  // which are out-of-project reads.
  await writeFile(join(base, 'CLAUDE.md'), '# Parent instructions SENTINEL_PARENT\n');
  await writeFile(join(base, 'CLAUDE.local.md'), '# Parent local instructions\n');
  // The macOS managed scope, injected so the test never touches `/Library`.
  await writeFile(join(managed, 'CLAUDE.md'), '# Managed instructions SENTINEL_MANAGED\n');
  await writeFile(
    join(managed, 'settings.json'),
    JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'], deny: [], ask: [], defaultMode: 'acceptEdits' },
    }),
  );

  await writeFile(
    join(root, '.claude', 'settings.json'),
    JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'], deny: [], ask: [], defaultMode: 'acceptEdits' },
      hooks: {
        SessionStart: [
          { matcher: 'startup|resume|compact', hooks: [{ type: 'command', command: 'echo hi' }] },
        ],
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo bash' }] },
          { hooks: [{ type: 'command', command: 'echo no-matcher' }] },
        ],
      },
      outputStyle: 'terse',
      mcpServers: { github: { command: 'npx' } },
      enabledPlugins: { 'market/plug': true },
      secretToken: 'sk-ant-should-not-persist',
      mysteryField: 'SENTINEL_UNKNOWN_FIELD',
    }),
  );
  await writeFile(
    join(root, '.claude', 'skills', 'foo', 'SKILL.md'),
    [
      '---',
      'name: foo',
      'description: "A foo skill that does foo things"',
      'allowed-tools: Read, Grep',
      '---',
      '# Foo skill',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(root, '.claude', 'agents', 'reviewer.md'),
    ['---', 'name: reviewer', 'tools:', '  - Read', '  - Bash', '---', '# Reviewer', ''].join('\n'),
  );
  await writeFile(
    join(root, '.claude', 'commands', 'deploy.md'),
    ['---', 'description: Deploy the app', '---', '# Deploy', ''].join('\n'),
  );
  await writeFile(join(root, '.claude', 'rules', 'rule.md'), '# Rule\n');
  await writeFile(join(root, '.claude', 'output-styles', 'terse.md'), '# Terse\n');
  await writeFile(join(root, '.claude', 'hooks', 'pre.sh'), 'echo hook\n');
  await writeFile(join(root, '.claude', 'unknown.xyz'), 'unknown element\n');
  await writeFile(join(outside, 'leaked.txt'), 'must not be discovered\n');
  await symlink(join('..', '..', 'outside'), join(root, '.claude', 'link'));
  await writeFile(
    join(root, '.mcp.json'),
    JSON.stringify({
      mcpServers: { project: { command: 'SENTINEL_MCP_COMMAND' } },
    }),
  );

  await mkdir(join(userConfigDir(home), 'skills', 'bar'), { recursive: true });
  await mkdir(join(userConfigDir(home), 'plugins', 'market', 'plug', 'skills', 'x'), {
    recursive: true,
  });
  await mkdir(join(userConfigDir(home), 'plugins', 'market', 'plug', 'agents'), {
    recursive: true,
  });
  await mkdir(join(userConfigDir(home), 'projects', encodeProjectDir(root), 'memory'), {
    recursive: true,
  });
  await writeFile(join(userConfigDir(home), 'CLAUDE.md'), '# User instructions\n');
  await writeFile(
    join(userConfigDir(home), 'settings.json'),
    JSON.stringify({ model: 'opus', enabledPlugins: { 'user/plug': true } }),
  );
  await writeFile(join(userConfigDir(home), 'skills', 'bar', 'SKILL.md'), '# Bar skill\n');
  await writeFile(
    join(userConfigDir(home), 'plugins', 'market', 'plug', 'skills', 'x', 'SKILL.md'),
    '# Plugin skill\n',
  );
  await writeFile(
    join(userConfigDir(home), 'plugins', 'market', 'plug', 'agents', 'reviewer.md'),
    '# Plugin agent\n',
  );
  await writeFile(
    join(userConfigDir(home), 'plugins', 'market', 'plug', 'plugin.json'),
    JSON.stringify({ name: 'plug' }),
  );
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
    managed,
  };
}

function collect(fixture: Fixture, access = CONSENTED) {
  return collectClaudeCodeHarness(fixture.project, access, fixture.home, fixture.managed);
}

function byPath(elements: readonly ObservedElement[]): Map<string, ObservedElement> {
  return new Map(elements.map((element) => [element.source.path ?? '', element]));
}

describe('collectClaudeCodeHarness', () => {
  it('discovers project and user elements when consent is granted', async () => {
    const fixture = await makeFixture();

    const snapshot = await collect(fixture);
    const paths = byPath(snapshot.elements);

    expect(paths.get('CLAUDE.md')?.native.kind).toBe('instructions');
    expect(paths.get('.claude/skills/foo/SKILL.md')?.native.kind).toBe('skills');
    expect(paths.get('.claude/agents/reviewer.md')?.native.kind).toBe('subagents');
    expect(paths.get('.claude/commands/deploy.md')?.native.kind).toBe('commands');
    expect(paths.get('.mcp.json#mcpServers')?.native.kind).toBe('mcp-configuration');
    expect(paths.get('~/.claude/CLAUDE.md')?.native.origin).toBe('user');
    expect(paths.get('~/.claude/skills/bar/SKILL.md')?.native.kind).toBe('skills');
    expect(
      paths.get(
        '~/.claude/projects/' + encodeProjectDir(fixture.project.root) + '/memory/MEMORY.md',
      )?.native.kind,
    ).toBe('memory');
    expect(paths.get('CLAUDE.md')?.source.digest).toMatch(/^sha256:/);
    const pluginSkill = paths.get('~/.claude/plugins/market/plug/skills/x/SKILL.md');
    expect(pluginSkill?.native.origin).toBe('plugin');
    expect(pluginSkill?.native.kind).toBe('skills');
  });

  it('discovers the CLAUDE.md tree: root, nested, parent, and managed', async () => {
    const fixture = await makeFixture();

    const snapshot = await collect(fixture);
    const paths = byPath(snapshot.elements);

    expect(paths.get('CLAUDE.md')).toMatchObject({
      native: { kind: 'instructions', origin: 'project', scope: 'project' },
    });
    expect(paths.get('CLAUDE.local.md')?.native.kind).toBe('instructions');
    expect(paths.get('docs/CLAUDE.md')?.native.kind).toBe('instructions');
    expect(paths.get('../CLAUDE.md')?.native.kind).toBe('instructions');
    expect(paths.get('../CLAUDE.local.md')?.native.kind).toBe('instructions');
  });

  it('makes subtree-specific-instruction reachable through discovery and resolution', async () => {
    const fixture = await makeFixture();

    const observed = await collect(fixture);
    const resolved = await resolveClaudeCode(observed);
    const nested = byPath(observed.elements).get('docs/CLAUDE.md');
    const finding = deriveFindings(observed, resolved).find(
      (entry) => entry.rule === 'subtree-specific-instruction',
    );

    // The finding is emitted from the adapter's real `directory-subtree`
    // applicability, not a synthetic resolved element.
    expect(nested?.native.kind).toBe('instructions');
    expect(finding?.elementIds).toEqual([nested?.id]);
  });

  it('discovers the managed scope when consent is granted', async () => {
    const fixture = await makeFixture();

    const snapshot = await collect(fixture);
    const paths = byPath(snapshot.elements);

    expect(paths.get(join(fixture.managed, 'CLAUDE.md'))).toMatchObject({
      native: { kind: 'instructions', origin: 'managed', scope: 'managed' },
    });
    expect(paths.get(`${join(fixture.managed, 'settings.json')}#permissions`)).toMatchObject({
      native: { origin: 'managed', scope: 'managed' },
    });
    expect(paths.get(`${join(fixture.managed, 'settings.json')}#defaultMode`)?.native.kind).toBe(
      'approval-policy',
    );
  });

  it('enumerates .mcp.json server names without persisting a command', async () => {
    const fixture = await makeFixture();

    const snapshot = await collect(fixture);
    const paths = byPath(snapshot.elements);

    expect(paths.get('.mcp.json#mcpServers')?.metadata).toEqual({ serverNames: ['project'] });
    expect(JSON.stringify(snapshot.elements)).not.toContain('SENTINEL_MCP_COMMAND');
  });

  it('records each instruction file once, with unique element ids', async () => {
    const fixture = await makeFixture();
    await mkdir(join(fixture.project.root, '.claude', 'skills', 'foo'), { recursive: true });
    await writeFile(
      join(fixture.project.root, '.claude', 'skills', 'foo', 'CLAUDE.md'),
      '# A skill file that happens to be named CLAUDE.md\n',
    );

    const snapshot = await collect(fixture);
    const ids = snapshot.elements.map((element) => element.id);
    const matches = snapshot.elements.filter(
      (element) => element.source.path === '.claude/skills/foo/CLAUDE.md',
    );

    // A second instruction producer would mint a duplicate id for CLAUDE.md, and
    // a file inside the config directory belongs to the `.claude/**` walk.
    expect(new Set(ids).size).toBe(ids.length);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.native.kind).toBe('skills');
  });

  it('does not read user, parent, or managed scope when consent is denied', async () => {
    const fixture = await makeFixture();

    const snapshot = await collect(fixture, DENIED);

    expect(snapshot.elements.some((element) => element.native.origin === 'user')).toBe(false);
    expect(snapshot.elements.some((element) => element.native.origin === 'managed')).toBe(false);
    expect(snapshot.elements.some((element) => element.native.origin === 'plugin')).toBe(false);
    expect(snapshot.elements.some((element) => (element.source.path ?? '').startsWith('../'))).toBe(
      false,
    );
    expect(
      snapshot.elements.some((element) => (element.source.path ?? '').includes('~/.claude')),
    ).toBe(false);
    expect(snapshot.runtime.version).toBeNull();
    expect(snapshot.adapter.runtimeCompatibility).toBe('unverified');
    expect(snapshot.diagnostics.map((entry) => entry.code)).toContain('consent-not-granted');
  });

  it('bounds the upward walk at MAX_ANCESTOR_DIRS and records the truncation', async () => {
    const base = await tempDir('pfl-claude-deep-');
    let root = base;
    for (let level = 0; level <= MAX_ANCESTOR_DIRS; level += 1) {
      root = join(root, `d${level}`);
    }
    const home = join(base, 'home');
    await mkdir(root, { recursive: true });
    await mkdir(userConfigDir(home), { recursive: true });
    // `base` is `MAX_ANCESTOR_DIRS + 1` levels above the root, so it is beyond
    // the ceiling and must not be read.
    await writeFile(join(base, 'CLAUDE.md'), '# Out of reach\n');

    const snapshot = await collectClaudeCodeHarness(
      { id: 'proj', displayName: 'owner/repo', root, remote: 'github.com/owner/repo' },
      CONSENTED,
      home,
      join(base, 'managed'),
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

  it('reports the detected runtime version when consented', async () => {
    const fixture = await makeFixture();

    const snapshot = await collect(fixture);

    expect(snapshot.runtime.version).toBe('2.1.100');
    expect(snapshot.adapter.runtimeCompatibility).toBe('verified');
  });

  it('records a symlink as skipped and never follows it', async () => {
    const fixture = await makeFixture();

    const snapshot = await collect(fixture);
    const paths = byPath(snapshot.elements);

    const link = [...paths.values()].find((element) => element.source.path === '.claude/link');
    expect(link).toMatchObject({ status: 'skipped', reason: 'symlink-not-followed' });
    expect(
      snapshot.elements.some((element) => (element.source.path ?? '').includes('leaked')),
    ).toBe(false);
  });

  it('preserves an unknown file inside a known area as unsupported', async () => {
    const fixture = await makeFixture();

    const snapshot = await collect(fixture);
    const unknown = byPath(snapshot.elements).get('.claude/unknown.xyz');

    expect(unknown).toMatchObject({ status: 'unsupported', reason: 'unsupported-by-adapter' });
    expect(unknown?.native.kind).toBe('unknown');
  });

  it('extracts settings structure without persisting raw values', async () => {
    const fixture = await makeFixture();

    const snapshot = await collect(fixture);
    const paths = byPath(snapshot.elements);

    expect(paths.get('.claude/settings.json#permissions')?.metadata).toEqual({
      allowCount: 1,
      denyCount: 0,
      askCount: 0,
    });
    // The approval mode is read from `permissions.defaultMode`, not a top-level
    // `defaultMode`, and rides on its own `approval-policy` element.
    expect(paths.get('.claude/settings.json#defaultMode')?.native.kind).toBe('approval-policy');
    expect(paths.get('.claude/settings.json#defaultMode')?.metadata).toEqual({
      approvalPolicy: 'acceptEdits',
    });
    expect(paths.get('.claude/settings.json#hooks')?.metadata).toEqual({
      eventNames: ['SessionStart', 'PreToolUse'],
      hookMatchers: ['startup|resume|compact', 'Bash'],
      hookMatcherCount: 2,
    });
    expect(paths.get('.claude/settings.json#outputStyle')?.metadata).toEqual({
      outputStyle: 'terse',
    });
    expect(paths.get('.claude/settings.json#mcpServers')?.metadata).toEqual({
      serverNames: ['github'],
    });
    expect(paths.get('.claude/settings.json#enabledPlugins')?.metadata).toEqual({
      pluginNames: ['market/plug'],
      enabledPluginCount: 1,
    });
    // Hook commands, types, and timeouts never leave the adapter.
    expect(JSON.stringify(snapshot.elements)).not.toContain('echo hi');
    expect(JSON.stringify(snapshot.elements)).not.toContain('echo no-matcher');
    expect(JSON.stringify(snapshot.elements)).not.toContain('sk-ant-should-not-persist');
    // Allowlist: an unknown field is not persisted even when it is not secret.
    expect(JSON.stringify(snapshot.elements)).not.toContain('SENTINEL_UNKNOWN_FIELD');
  });

  it('keeps plugin-provided elements distinguishable from the plugin element', async () => {
    const fixture = await makeFixture();

    const snapshot = await collect(fixture);
    const paths = byPath(snapshot.elements);

    expect(paths.get('~/.claude/plugins/market/plug/plugin.json')).toMatchObject({
      native: { kind: 'plugin', origin: 'plugin' },
    });
    expect(paths.get('~/.claude/plugins/market/plug/skills/x/SKILL.md')?.native.kind).toBe(
      'skills',
    );
    expect(paths.get('~/.claude/plugins/market/plug/agents/reviewer.md')?.native.kind).toBe(
      'subagents',
    );
    // Enabled state is the settings element; installed state is the walk.
    expect(paths.get('~/.claude/settings.json#enabledPlugins')?.metadata).toEqual({
      pluginNames: ['user/plug'],
      enabledPluginCount: 1,
    });
  });

  it('resolves frontmatter structure for skills, subagents, and commands', async () => {
    const fixture = await makeFixture();

    const snapshot = await collect(fixture);
    const paths = byPath(snapshot.elements);

    expect(paths.get('.claude/skills/foo/SKILL.md')?.metadata).toEqual({
      format: 'md',
      hasFrontmatter: true,
      frontmatterKeys: ['name', 'description', 'allowed-tools'],
      descriptionLength: 'A foo skill that does foo things'.length,
      toolNames: ['Read', 'Grep'],
    });
    expect(paths.get('.claude/agents/reviewer.md')?.metadata).toEqual({
      format: 'md',
      hasFrontmatter: true,
      frontmatterKeys: ['name', 'tools'],
      toolNames: ['Read', 'Bash'],
    });
    expect(paths.get('.claude/commands/deploy.md')?.metadata).toEqual({
      format: 'md',
      hasFrontmatter: true,
      frontmatterKeys: ['description'],
      descriptionLength: 'Deploy the app'.length,
    });
    // Only structural facts are persisted; the description value never is.
    expect(JSON.stringify(snapshot.elements)).not.toContain('A foo skill that does foo things');
  });

  it('does not extract frontmatter metadata for instruction files', async () => {
    const fixture = await makeFixture();
    await writeFile(
      join(fixture.project.root, 'docs', 'CLAUDE.md'),
      ['---', 'name: not-an-instruction-carrier', '---', '# Nested', ''].join('\n'),
    );

    const snapshot = await collect(fixture);
    const nested = byPath(snapshot.elements).get('docs/CLAUDE.md');

    expect(nested?.native.kind).toBe('instructions');
    expect(nested?.metadata).toEqual({ format: 'md' });
  });

  it('records malformed frontmatter as a diagnostic and keeps the element', async () => {
    const fixture = await makeFixture();
    await mkdir(join(fixture.project.root, '.claude', 'skills', 'malformed'), { recursive: true });
    await writeFile(
      join(fixture.project.root, '.claude', 'skills', 'malformed', 'SKILL.md'),
      ['---', 'name: malformed', 'description: no closing fence'].join('\n'),
    );

    const snapshot = await collect(fixture);
    const element = byPath(snapshot.elements).get('.claude/skills/malformed/SKILL.md');

    expect(element?.status).toBe('observed');
    expect(element?.metadata).toMatchObject({ hasFrontmatter: true });
    expect(snapshot.diagnostics.map((entry) => entry.code)).toContain('invalid-frontmatter');
  });

  it('records the built-in instruction layer as opaque', async () => {
    const fixture = await makeFixture();

    const snapshot = await collect(fixture);
    const opaque = snapshot.elements.filter((element) => element.inspectability === 'opaque');

    expect(opaque).toHaveLength(1);
    expect(opaque[0]?.native.kind).toBe('runtime-provided-instructions');
    expect(opaque[0]?.native.origin).toBe('builtin');
  });

  it('is partial because of the symlink and the unknown element', async () => {
    const fixture = await makeFixture();

    const snapshot = await collect(fixture);

    expect(snapshot.completeness).toBe('partial');
  });
});

describe('managedConfigDirFor', () => {
  it('gates the default managed read on macOS but reads an injected base anywhere', () => {
    // Reverting the platform gate to always return MANAGED_CONFIG_DIR turns the
    // first expectation red.
    expect(managedConfigDirFor('linux', undefined)).toBeNull();
    expect(managedConfigDirFor('darwin', undefined)).toBe(MANAGED_CONFIG_DIR);
    expect(managedConfigDirFor('linux', '/tmp/managed')).toBe('/tmp/managed');
  });
});

describe('collectClaudeCodeHarness symlinked settings (S1)', () => {
  const SECRET_SETTINGS = JSON.stringify({
    permissions: { allow: ['Bash(curl LEAKED_SETTINGS_TOKEN)'], deny: [], ask: [] },
    hooks: { SessionStart: [] },
    token: 'sk-ant-should-not-be-read',
  });

  interface SymlinkFixture {
    project: { id: string; displayName: string; root: string; remote: string };
    home: string;
    managed: string;
  }

  async function makeSymlinkFixture(): Promise<SymlinkFixture> {
    const base = await tempDir('pfl-claude-symlink-');
    const root = join(base, 'project');
    const home = join(base, 'home');
    const outside = join(base, 'outside');

    await mkdir(join(root, '.claude'), { recursive: true });
    await mkdir(join(home, '.claude'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret-settings.json'), SECRET_SETTINGS);

    // A symlinked project settings file needs no consent and must never be read.
    await symlink(
      join('..', '..', 'outside', 'secret-settings.json'),
      join(root, '.claude', 'settings.json'),
    );
    // The same for the user scope and the user MCP file.
    await symlink(
      join('..', '..', 'outside', 'secret-settings.json'),
      join(home, '.claude', 'settings.json'),
    );
    await symlink(join('..', 'outside', 'secret-settings.json'), join(home, '.claude.json'));

    return {
      project: { id: 'proj', displayName: 'owner/repo', root, remote: 'github.com/owner/repo' },
      home,
      managed: join(base, 'managed'),
    };
  }

  it('records each symlinked settings file as skipped and never parses its target', async () => {
    const fixture = await makeSymlinkFixture();

    const snapshot = await collect(fixture);
    const paths = byPath(snapshot.elements);

    for (const path of ['.claude/settings.json', '~/.claude/settings.json', '~/.claude.json']) {
      expect(paths.get(path)).toMatchObject({
        status: 'skipped',
        reason: 'symlink-not-followed',
      });
    }
    // The old, unguarded read parsed the target and emitted these config elements.
    expect(paths.has('.claude/settings.json#permissions')).toBe(false);
    expect(paths.has('~/.claude/settings.json#permissions')).toBe(false);
    expect(JSON.stringify(snapshot.elements)).not.toContain('sk-ant-should-not-be-read');
    expect(JSON.stringify(snapshot.elements)).not.toContain('LEAKED_SETTINGS_TOKEN');
  });

  it('does not read a fixed path through a symlinked ancestor directory', async () => {
    const base = await tempDir('pfl-claude-ancestor-');
    const root = join(base, 'project');
    const home = join(base, 'home');
    const outside = join(base, 'outside');
    await mkdir(join(outside, 'claude-dir'), { recursive: true });
    await mkdir(root, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(outside, 'claude-dir', 'settings.json'), SECRET_SETTINGS);
    // `.claude` itself is a symlink: lstat on the leaf would see a regular file.
    await symlink(join(outside, 'claude-dir'), join(root, '.claude'));

    const snapshot = await collectClaudeCodeHarness(
      { id: 'proj', displayName: 'owner/repo', root, remote: 'github.com/owner/repo' },
      CONSENTED,
      home,
      join(base, 'managed'),
    );
    const paths = byPath(snapshot.elements);

    expect(paths.get('.claude/settings.json')).toMatchObject({
      status: 'skipped',
      reason: 'symlink-not-followed',
    });
    expect(paths.has('.claude/settings.json#permissions')).toBe(false);
    expect(JSON.stringify(snapshot.elements)).not.toContain('LEAKED_SETTINGS_TOKEN');
  });

  it('does not read a hardlinked settings file', async () => {
    const base = await tempDir('pfl-claude-hardlink-');
    const root = join(base, 'project');
    const home = join(base, 'home');
    await mkdir(join(root, '.claude'), { recursive: true });
    await mkdir(home, { recursive: true });
    const shared = join(base, 'shared-settings.json');
    await writeFile(shared, SECRET_SETTINGS);
    await link(shared, join(root, '.claude', 'settings.json'));

    const snapshot = await collectClaudeCodeHarness(
      { id: 'proj', displayName: 'owner/repo', root, remote: 'github.com/owner/repo' },
      CONSENTED,
      home,
      join(base, 'managed'),
    );
    const paths = byPath(snapshot.elements);

    expect(paths.get('.claude/settings.json')).toMatchObject({
      status: 'skipped',
      reason: 'hardlink-not-followed',
    });
    expect(paths.has('.claude/settings.json#permissions')).toBe(false);
  });
});
