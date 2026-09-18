import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { deriveFindings } from '../../classify/findings.js';
import { getClassifierContribution } from '../registry.js';
import type { ObservedElement } from '../../core/observed.js';
import { MAX_ANCESTOR_DIRS, MAX_PARSE_BYTES } from '../../limits.js';
import { collectCodexHarness, type AssertKindsNarrow } from './discovery.js';
import {
  FALLBACK_ELEMENT_KINDS,
  KNOWN_ELEMENT_KINDS,
  UNKNOWN_ELEMENT_KIND,
  USER_DIR_KIND,
  userConfigDir,
  type CodexRecordedKind,
} from './paths.js';
import { resolveCodex } from './resolve.js';

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

describe('element kind boundary', () => {
  it('keeps the fallback and unknown kinds out of the known kinds', () => {
    for (const kind of [...FALLBACK_ELEMENT_KINDS, UNKNOWN_ELEMENT_KIND]) {
      expect((KNOWN_ELEMENT_KINDS as readonly string[]).includes(kind)).toBe(false);
    }
  });
});

// A typo'd kind must not compile: if the union widened back to `string` this
// directive would be unused, which is itself a compile error (roadmap #131).
// @ts-expect-error
const typoKind: CodexRecordedKind = 'skils';
void typoKind;

// Pins the helper signatures, not only the union: if a builder helper's `kind`
// is retyped to `string`, `AssertKindsNarrow` becomes `never` and this fails.
const helpersNarrow: AssertKindsNarrow = true;
void helpersNarrow;

const CONSENTED = { user: true, install: true, grantedScopes: ['codex:user'] };
const DENIED = { user: false, install: false, grantedScopes: [] };

/** Enough `allow` decisions to cross `BROAD_TOOL_ACCESS_MIN_ALLOW`. */
const RULE_ALLOW_COUNT = 12;
const RULE_DENY_COUNT = 2;
/** A rule argument that must never be persisted, only counted. */
const RULE_SENTINEL = 'SENTINEL_RULE_ARG';

function rulesFileContent(): string {
  return [
    '# Codex prefix rules',
    '',
    ...Array.from(
      { length: RULE_ALLOW_COUNT },
      (_, index) => `prefix_rule(pattern=["cmd${index}"], decision="allow")`,
    ),
    `prefix_rule(pattern=["rm", "-rf", "${RULE_SENTINEL}"], decision="forbidden")`,
    "prefix_rule(pattern=['git', 'push'], decision='deny')",
    '# a comment that mentions decision="allow" is not a rule',
    '',
  ].join('\n');
}

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
      'service_tier = "flex"',
      'model_context_window = 272000',
      'model_max_output_tokens = 128000',
      'model_auto_compact_token_limit = 200000',
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
      'dependencies: [foundation, formatting]',
      '---',
      '# Skill',
      '',
    ].join('\n'),
  );
  await writeFile(join(configDir, 'rules', 'default.rules'), rulesFileContent());
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
    expect(paths.get('~/.codex/rules/default.rules')?.native.kind).toBe('rules');
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

  it('does not walk into a nested checkout boundary (issue #162)', async () => {
    const { project, home } = await makeFixture();
    const vendor = join(project.root, 'vendor');
    await mkdir(join(vendor, 'inner'), { recursive: true });
    await writeFile(join(vendor, 'AGENTS.md'), '# vendor instructions\n');
    await writeFile(join(vendor, 'inner', 'AGENTS.md'), '# vendor nested instructions\n');
    await mkdir(join(vendor, '.git'), { recursive: true });

    const snapshot = await collectCodexHarness(project, CONSENTED, home);
    const paths = byPath(snapshot.elements);

    expect(paths.has('vendor/AGENTS.md')).toBe(false);
    expect(paths.has('vendor/inner/AGENTS.md')).toBe(false);
    expect(snapshot.diagnostics.some((d) => d.code === 'nested-checkout-not-walked')).toBe(true);
    // Positive control: the normal nested element is still discovered.
    expect(paths.get('docs/AGENTS.md')?.native.kind).toBe('instructions');
  });

  it('still discovers project instructions when the root itself has .git', async () => {
    const { project, home } = await makeFixture();
    await mkdir(join(project.root, '.git'), { recursive: true });

    const snapshot = await collectCodexHarness(project, CONSENTED, home);
    const paths = byPath(snapshot.elements);

    expect(paths.get('AGENTS.md')?.native.kind).toBe('instructions');
    expect(paths.get('docs/AGENTS.md')?.native.kind).toBe('instructions');
  });

  it('makes subtree-specific-instruction reachable through discovery and resolution', async () => {
    const { project, home } = await makeFixture();

    const observed = await collectCodexHarness(project, CONSENTED, home);
    const resolved = await resolveCodex(observed);
    const nested = byPath(observed.elements).get('docs/AGENTS.md');
    const finding = deriveFindings(
      observed,
      resolved,
      getClassifierContribution().findingKinds,
    ).find((entry) => entry.rule === 'subtree-specific-instruction');

    // The finding is emitted from the adapter's real `directory-subtree`
    // applicability, not a synthetic resolved element.
    expect(nested?.native.kind).toBe('instructions');
    expect(finding?.elementIds).toEqual([nested?.id]);
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
    expect(paths.get('~/.codex/config.toml#model')?.metadata).toEqual({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'medium',
      serviceTier: 'flex',
    });
    expect(paths.get('~/.codex/config.toml#context')?.metadata).toEqual({
      contextWindow: 272000,
      maxOutputTokens: 128000,
      autoCompactTokenLimit: 200000,
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
      frontmatterKeys: ['name', 'description', 'allowed-tools', 'dependencies'],
      descriptionLength: 'A Codex skill'.length,
      toolNames: ['Read', 'Write'],
      dependencyNames: ['foundation', 'formatting'],
    });
    expect(JSON.stringify(snapshot.elements)).not.toContain('A Codex skill');
  });

  it('emits a rules element and a counts-only permissions fragment', async () => {
    const { project, home } = await makeFixture();

    const snapshot = await collectCodexHarness(project, CONSENTED, home);
    const paths = byPath(snapshot.elements);

    expect(paths.get('~/.codex/rules/default.rules')).toMatchObject({
      native: { kind: 'rules', origin: 'user', scope: 'user' },
    });
    // `toEqual` (not `toMatchObject`): the rules element carries only the file
    // format, so a reverted guard that merges the counts back in turns this red.
    expect(paths.get('~/.codex/rules/default.rules')?.metadata).toEqual({ format: 'rules' });
    expect(paths.get('~/.codex/rules/default.rules#permissions')).toMatchObject({
      native: { kind: 'permissions', origin: 'user', scope: 'user' },
    });
    // Exact equality: the fragment carries only the counts, so a regression that
    // added a pattern or argument to the metadata turns this red.
    expect(paths.get('~/.codex/rules/default.rules#permissions')?.metadata).toEqual({
      allowCount: RULE_ALLOW_COUNT,
      denyCount: RULE_DENY_COUNT,
    });
    // The fragment is a distinct path, so it is a distinct element id.
    expect(paths.get('~/.codex/rules/default.rules')?.id).not.toBe(
      paths.get('~/.codex/rules/default.rules#permissions')?.id,
    );
    // Only counts leave the walk: no pattern and no argument is persisted.
    expect(JSON.stringify(snapshot.elements)).not.toContain(RULE_SENTINEL);
    expect(JSON.stringify(snapshot.elements)).not.toContain('cmd0');
  });

  it('makes broad-tool-access reachable for a Codex permission set', async () => {
    const { project, home } = await makeFixture();

    const observed = await collectCodexHarness(project, CONSENTED, home);
    const resolved = await resolveCodex(observed);
    const permissions = byPath(observed.elements).get('~/.codex/rules/default.rules#permissions');
    const finding = deriveFindings(
      observed,
      resolved,
      getClassifierContribution().findingKinds,
    ).find((entry) => entry.rule === 'broad-tool-access');

    expect(permissions).toBeDefined();
    expect(finding?.elementIds).toContain(permissions?.id);
    expect(finding?.message).toContain(String(RULE_ALLOW_COUNT));
  });

  it('redacts a secret-shaped dependency name before it is persisted', async () => {
    const { project, home } = await makeFixture();
    const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwx'; // gitleaks:allow
    await writeFile(
      join(userConfigDir(home), 'skills', 'secret.md'),
      ['---', `dependencies: [${secret}]`, '---'].join('\n'),
    );

    const snapshot = await collectCodexHarness(project, CONSENTED, home);
    const element = byPath(snapshot.elements).get('~/.codex/skills/secret.md');

    expect(element?.metadata['dependencyNames']).toEqual(['[redacted]']);
    expect(JSON.stringify(snapshot.elements)).not.toContain(secret);
  });

  it('does not open user scope when consent is denied', async () => {
    const { project, home } = await makeFixture();

    const snapshot = await collectCodexHarness(project, DENIED, home);

    expect(snapshot.elements.some((element) => element.native.origin === 'user')).toBe(false);
    expect(snapshot.runtime.version).toBeNull();
    expect(snapshot.adapter.runtimeCompatibility).toBe('unverified');
    expect(snapshot.diagnostics.map((entry) => entry.code)).toContain(
      'consent-not-granted:install',
    );
    expect(snapshot.diagnostics.map((entry) => entry.code)).toContain('consent-not-granted:user');
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

describe('Codex element kinds (M7 Phase 4)', () => {
  it('carries the corrected kinds and withdraws the dead ones', () => {
    const kinds = KNOWN_ELEMENT_KINDS as readonly string[];

    expect(kinds).toContain('rules');
    expect(kinds).toContain('model-configuration');
    expect(kinds).not.toContain('skill-dependencies');
    expect(kinds).not.toContain('multi-agent-configuration');
    // `rules` is instructional content, so it is its own kind, not `permissions`.
    expect(USER_DIR_KIND.rules).toBe('rules');
  });
});

describe('duplicate catalog names', () => {
  it('emits a diagnostic when a skill name exists in both project and user scope', async () => {
    const base = await tempDir('pfl-codex-dup-');
    const root = join(base, 'project');
    const home = join(base, 'home');
    const configDir = userConfigDir(home);
    await mkdir(join(root, '.codex', 'skills', 'foo'), { recursive: true });
    await mkdir(join(configDir, 'skills', 'foo'), { recursive: true });

    await writeFile(join(root, '.codex', 'skills', 'foo', 'SKILL.md'), '# Project foo\n');
    await writeFile(join(configDir, 'skills', 'foo', 'SKILL.md'), '# User foo\n');

    const snapshot = await collectCodexHarness(
      { id: 'proj', displayName: 'owner/repo', root, remote: 'github.com/owner/repo' },
      CONSENTED,
      home,
    );

    const duplicate = snapshot.diagnostics.find(
      (d) => d.code === 'duplicate-element-name' && d.message.includes('"foo"'),
    );
    expect(duplicate).toBeDefined();
    expect(duplicate?.message).toContain('.codex/skills/foo/SKILL.md');
    expect(duplicate?.message).toContain('~/.codex/skills/foo/SKILL.md');
    expect(duplicate?.message).not.toContain('plugin');
    expect(duplicate?.message).not.toContain('not deterministic');
  });

  it('does not count a skipped symlink as a competing definition', async () => {
    const base = await tempDir('pfl-codex-dup-sym-');
    const root = join(base, 'project');
    const home = join(base, 'home');
    const configDir = userConfigDir(home);
    const outside = join(base, 'outside');
    await mkdir(join(root, '.codex', 'skills', 'foo'), { recursive: true });
    await mkdir(join(configDir, 'skills', 'foo'), { recursive: true });
    await mkdir(outside, { recursive: true });

    await writeFile(join(root, '.codex', 'skills', 'foo', 'SKILL.md'), '# Project foo\n');
    await symlink(
      join('..', '..', 'outside', 'foo-skill'),
      join(configDir, 'skills', 'foo', 'SKILL.md'),
    );

    const snapshot = await collectCodexHarness(
      { id: 'proj', displayName: 'owner/repo', root, remote: 'github.com/owner/repo' },
      CONSENTED,
      home,
    );

    const duplicate = snapshot.diagnostics.find(
      (d) => d.code === 'duplicate-element-name' && d.message.includes('"foo"'),
    );
    expect(duplicate).toBeUndefined();
  });
});
