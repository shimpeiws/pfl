import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ObservedElement, ObservedSnapshot } from '../../core/observed.js';
import type { AccessPolicy, ProjectContext } from '../types.js';
import { collectOpencodeHarness, type AssertKindsNarrow } from './discovery.js';
import {
  FALLBACK_ELEMENT_KINDS,
  KNOWN_ELEMENT_KINDS,
  UNKNOWN_ELEMENT_KIND,
  type OpenCodeRecordedKind,
} from './paths.js';

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
const typoKind: OpenCodeRecordedKind = 'skils';
void typoKind;

// Pins the helper signatures, not only the union.
const helpersNarrow: AssertKindsNarrow = true;
void helpersNarrow;

const CONSENTED: AccessPolicy = {
  user: true,
  install: true,
  grantedScopes: ['opencode:user', 'opencode:install'],
};
const DENIED: AccessPolicy = { user: false, install: false, grantedScopes: [] };

const SECRET_SENTINEL = 'sk-ant-EXFILTRATION-0123456789';

interface Fixture {
  project: ProjectContext;
  home: string;
  managed: string;
  root: string;
}

async function makeFixture(): Promise<Fixture> {
  const base = await tempDir('pfl-opencode-');
  const root = join(base, 'project');
  const home = join(base, 'home');
  const managed = join(base, 'managed');
  const outside = join(base, 'outside');

  await mkdir(join(root, '.opencode', 'agent'), { recursive: true });
  await mkdir(join(root, '.opencode', 'command'), { recursive: true });
  await mkdir(join(root, '.opencode', 'skill', 'dup'), { recursive: true });
  await mkdir(join(root, '.opencode', 'plugins'), { recursive: true });
  await mkdir(join(root, '.opencode', 'tool'), { recursive: true });
  await mkdir(join(root, '.opencode', 'mode'), { recursive: true });
  await mkdir(join(root, '.claude', 'skills', 'compat'), { recursive: true });
  await mkdir(join(root, '.agents', 'skills', 'agentskill'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'sub'), { recursive: true });
  await mkdir(join(home, '.config', 'opencode', 'agent'), { recursive: true });
  await mkdir(join(home, '.config', 'opencode', 'skill', 'dup'), { recursive: true });
  await mkdir(join(home, '.config', 'opencode', 'skill', 'useronly'), { recursive: true });
  await mkdir(join(home, '.claude', 'skills', 'uclaude'), { recursive: true });
  await mkdir(join(home, '.agents', 'skills', 'uagents'), { recursive: true });
  await mkdir(managed, { recursive: true });
  await mkdir(outside, { recursive: true });

  // Instructions: root AGENTS.md suppresses CLAUDE.md beside it; `sub/CLAUDE.md`
  // is the fallback and is read.
  await writeFile(join(root, 'AGENTS.md'), '# project instructions\n');
  await writeFile(join(root, 'CLAUDE.md'), '# suppressed root fallback\n');
  await writeFile(join(root, 'docs', 'AGENTS.md'), '# nested instructions\n');
  await writeFile(join(root, 'docs', 'CLAUDE.md'), '# suppressed nested fallback\n');
  await writeFile(join(root, 'sub', 'CLAUDE.md'), '# fallback read\n');
  // The parent directory of the project is an out-of-project instruction read.
  await writeFile(join(base, 'AGENTS.md'), '# parent instructions\n');
  await writeFile(join(base, 'CLAUDE.md'), '# suppressed parent fallback\n');

  await writeFile(join(root, 'opencode.json'), JSON.stringify({ model: 'project-root-model' }));
  await writeFile(
    join(root, '.opencode', 'opencode.jsonc'),
    [
      '{',
      '  // a project config with JSONC tolerance',
      '  "model": "anthropic/claude-sonnet-4",',
      '  "small_model": "anthropic/claude-haiku",',
      '  "mcp": { "github": { "type": "local" }, "sentry": {} },',
      '  "permission": {',
      '    "bash": "ask",',
      `    "webfetch": { "*.example.com": "allow", "evil.com": "deny" },`,
      '    "edit": "allow",',
      '  },',
      '  "compaction": { "auto": true },',
      '  "tool_output": { "max_lines": 100 },',
      '  "shell": "/bin/zsh",',
      '  "formatter": { "prettier": {} },',
      '  "lsp": { "typescript": {} },',
      '  "plugin": ["opencode-plugin-foo", ["@scope/bar", { "x": 1 }], "./local-plugin.ts"],',
      '  "tools": { "myTool": true },',
      `  "instructions": ["../shared/AGENTS.md", "https://example.com/p?token=${SECRET_SENTINEL}", "docs/*.md"],`,
      '  "references": {',
      '    "refpath": { "path": "../refs" },',
      '    "refrel": { "path": "vendor/refs" },',
      '    "refabs": { "path": "/abs/refs" },',
      '    "refglob": { "path": "docs/*.md" },',
      '    "refrepo": { "repository": "org/repo", "branch": "main" },',
      '    "repshort": "owner/repo",',
      '    "refgit": "github.com/org/repo.git",',
      '    "refbad": { "branch": "main" }',
      '  },',
      '  "skills": {',
      '    "paths": ["./extra-skills"],',
      '    "urls": ["https://example.com/skills/"]',
      '  },',
      '  "agent": {',
      '    "primary-agent": { "mode": "primary" },',
      '    "sub-agent": { "mode": "subagent" },',
      '    "default-agent": {}',
      '  },',
      '  "command": { "deploy": {} },',
      '  "mode": { "legacy-mode": {} },',
      '  "default_agent": "primary-agent",',
      '  "unknown_key": { "x": 1 },',
      '  "$schema": "https://opencode.ai/config.json"',
      '}',
    ].join('\n'),
  );

  await writeFile(
    join(root, '.opencode', 'agent', 'reviewer.md'),
    ['---', 'description: "a subagent"', 'mode: subagent', '---', 'body', ''].join('\n'),
  );
  await writeFile(
    join(root, '.opencode', 'agent', 'primary.md'),
    ['---', 'description: "a primary agent"', 'mode: primary', '---', 'body', ''].join('\n'),
  );
  // An agent file with no frontmatter falls to the conservative subagent default.
  await writeFile(join(root, '.opencode', 'agent', 'bare.md'), 'no frontmatter here\n');
  await writeFile(
    join(root, '.opencode', 'command', 'deploy.md'),
    ['---', 'description: "deploy"', '---', 'body', ''].join('\n'),
  );
  await writeFile(
    join(root, '.opencode', 'skill', 'dup', 'SKILL.md'),
    ['---', 'name: dup', 'description: "project dup"', '---', 'body', ''].join('\n'),
  );
  await writeFile(join(root, '.opencode', 'plugins', 'local.ts'), 'export default {}\n');
  await writeFile(join(root, '.opencode', 'tool', 'mytool.ts'), 'export default {}\n');
  await writeFile(join(root, '.opencode', 'mode', 'legacy.md'), '# legacy mode\n');
  await writeFile(
    join(root, '.opencode', 'mode', 'allmode.md'),
    ['---', 'description: "an all-mode agent"', 'mode: all', '---', 'body', ''].join('\n'),
  );
  await writeFile(
    join(root, '.opencode', 'mode', 'submode.md'),
    ['---', 'description: "a subagent in mode/"', 'mode: subagent', '---', 'body', ''].join('\n'),
  );
  await writeFile(
    join(root, '.claude', 'skills', 'compat', 'SKILL.md'),
    ['---', 'name: compat', 'description: "claude compat"', '---', 'body', ''].join('\n'),
  );
  await writeFile(
    join(root, '.agents', 'skills', 'agentskill', 'SKILL.md'),
    ['---', 'name: agentskill', 'description: "agents compat"', '---', 'body', ''].join('\n'),
  );

  // A symlinked command escapes the project and must never be followed. A
  // symlink that is not a candidate name must not become an instruction either.
  await symlink(outside, join(root, '.opencode', 'command', 'link.md'));
  await symlink(outside, join(root, 'elsewhere'));
  // An unreadable command must be recorded, not dropped.
  await writeFile(join(root, '.opencode', 'command', 'broken.md'), '# broken\n');
  await chmod(join(root, '.opencode', 'command', 'broken.md'), 0o000);

  await writeFile(join(home, '.config', 'opencode', 'AGENTS.md'), '# user instructions\n');
  await writeFile(
    join(home, '.config', 'opencode', 'opencode.json'),
    JSON.stringify({ model: 'user-model', permission: { bash: 'deny' } }),
  );
  await writeFile(
    join(home, '.config', 'opencode', 'agent', 'user-agent.md'),
    ['---', 'description: "user agent"', 'mode: subagent', '---', 'body', ''].join('\n'),
  );
  await writeFile(
    join(home, '.config', 'opencode', 'skill', 'dup', 'SKILL.md'),
    ['---', 'name: dup', 'description: "user dup"', '---', 'body', ''].join('\n'),
  );
  await writeFile(
    join(home, '.config', 'opencode', 'skill', 'useronly', 'SKILL.md'),
    ['---', 'name: useronly', 'description: "user only"', '---', 'body', ''].join('\n'),
  );
  await writeFile(
    join(home, '.claude', 'skills', 'uclaude', 'SKILL.md'),
    ['---', 'name: uclaude', 'description: "user claude"', '---', 'body', ''].join('\n'),
  );
  await writeFile(
    join(home, '.agents', 'skills', 'uagents', 'SKILL.md'),
    ['---', 'name: uagents', 'description: "user agents"', '---', 'body', ''].join('\n'),
  );

  await writeFile(
    join(managed, 'opencode.json'),
    JSON.stringify({ model: 'managed-model', permission: { bash: 'deny' } }),
  );

  return {
    root,
    home,
    managed,
    project: { id: 'proj', displayName: 'owner/repo', root },
  };
}

function collect(fixture: Fixture, access: AccessPolicy): Promise<ObservedSnapshot> {
  return collectOpencodeHarness(fixture.project, access, fixture.home, fixture.managed, '');
}

function paths(elements: readonly ObservedElement[]): string[] {
  return elements.map((element) => element.source.path ?? '');
}

function byPath(elements: readonly ObservedElement[], path: string): ObservedElement {
  const found = elements.find((element) => element.source.path === path);
  if (found === undefined) throw new Error(`expected an element at ${path}`);
  return found;
}

function outsideProjectPaths(observed: ObservedSnapshot): string[] {
  return paths(observed.elements).filter(
    (path) => path.startsWith('~/') || path.startsWith('../') || path.startsWith('/'),
  );
}

describe('collectOpencodeHarness consent gating', () => {
  it('serves nothing out of project without a grant', async () => {
    const fixture = await makeFixture();
    const observed = await collect(fixture, DENIED);

    expect(outsideProjectPaths(observed)).toEqual([]);
    expect(observed.runtime.version).toBeNull();
    const codes = observed.diagnostics.map((entry) => entry.code);
    expect(codes).toContain('consent-not-granted:install');
    expect(codes).toContain('consent-not-granted:user');
    // Project-local discovery still runs.
    expect(paths(observed.elements)).toContain('AGENTS.md');
    expect(paths(observed.elements)).toContain('.opencode/opencode.jsonc#mcp');
  });
});

describe('collectOpencodeHarness instructions', () => {
  it('reads AGENTS.md with the CLAUDE.md fallback and suppresses the suppressed copy', async () => {
    const fixture = await makeFixture();
    const observed = await collect(fixture, CONSENTED);
    const found = paths(observed.elements);

    expect(found).toContain('AGENTS.md');
    expect(found).toContain('docs/AGENTS.md');
    expect(found).toContain('sub/CLAUDE.md');
    expect(found).toContain('../AGENTS.md');
    expect(found).toContain('~/.config/opencode/AGENTS.md');
    // A CLAUDE.md beside an AGENTS.md is not a second element.
    expect(found).not.toContain('CLAUDE.md');
    expect(found).not.toContain('docs/CLAUDE.md');
    expect(found).not.toContain('../CLAUDE.md');
  });
});

describe('collectOpencodeHarness config', () => {
  it('records the modelled config keys structurally', async () => {
    const fixture = await makeFixture();
    const observed = await collect(fixture, CONSENTED);
    const elements = observed.elements;

    expect(byPath(elements, '.opencode/opencode.jsonc#mcp').metadata['serverNames']).toEqual([
      'github',
      'sentry',
    ]);
    expect(byPath(elements, '.opencode/opencode.jsonc#permission').metadata).toMatchObject({
      allowCount: 2,
      askCount: 1,
      denyCount: 1,
      topLevelRuleCount: 3,
    });
    expect(byPath(elements, '.opencode/opencode.jsonc#model').metadata).toMatchObject({
      model: 'anthropic/claude-sonnet-4',
      smallModel: 'anthropic/claude-haiku',
    });
    expect(byPath(elements, '.opencode/opencode.jsonc#plugin').metadata).toMatchObject({
      pluginNames: ['opencode-plugin-foo', '@scope/bar'],
      // A relative-path specifier is persisted as its kind, not a name.
      pluginTargetKinds: ['path'],
      pluginCount: 3,
    });
    expect(byPath(elements, '.opencode/opencode.jsonc#tools').metadata['toolNames']).toEqual([
      'myTool',
    ]);
    expect(byPath(elements, '.opencode/opencode.jsonc#tooling').metadata['toolingKeys']).toEqual([
      'formatter',
      'lsp',
    ]);
    expect(
      byPath(elements, '.opencode/opencode.jsonc#project').metadata['projectConfigKeys'],
    ).toEqual(['default_agent']);
    // The comments/trailing commas did not prevent the parse.
    expect(observed.diagnostics.some((entry) => entry.code === 'invalid-config')).toBe(false);
  });

  it('records inline agents split by mode and legacy modes as unsupported', async () => {
    const fixture = await makeFixture();
    const observed = await collect(fixture, CONSENTED);

    expect(
      byPath(observed.elements, '.opencode/opencode.jsonc#agent.primary-agent').native.kind,
    ).toBe('agents');
    expect(byPath(observed.elements, '.opencode/opencode.jsonc#agent.sub-agent').native.kind).toBe(
      'subagents',
    );
    expect(
      byPath(observed.elements, '.opencode/opencode.jsonc#agent.default-agent').native.kind,
    ).toBe('subagents');
    const legacy = byPath(observed.elements, '.opencode/opencode.jsonc#mode.legacy-mode');
    expect(legacy).toMatchObject({ status: 'unsupported', reason: 'unsupported-by-adapter' });
  });

  it('records an unknown config key as unsupported, not dropped', async () => {
    const fixture = await makeFixture();
    const observed = await collect(fixture, CONSENTED);

    expect(byPath(observed.elements, '.opencode/opencode.jsonc#unknown_key')).toMatchObject({
      status: 'unsupported',
    });
    // `$schema` is a document pointer, not harness configuration.
    expect(paths(observed.elements)).not.toContain('.opencode/opencode.jsonc#$schema');
  });

  it('records a non-string declaration as unsupported and caps unknown keys', async () => {
    const fixture = await makeFixture();
    const config: Record<string, unknown> = { instructions: [42] };
    for (let index = 0; index < 300; index += 1) config[`unknown_${index}`] = index;
    await writeFile(join(fixture.root, 'opencode.json'), JSON.stringify(config));

    const observed = await collect(fixture, CONSENTED);

    expect(byPath(observed.elements, 'opencode.json#instructions.0')).toMatchObject({
      status: 'unsupported',
    });
    expect(observed.diagnostics.map((entry) => entry.code)).toContain('config-items-truncated');
    const unknown = observed.elements.filter((element) =>
      element.source.path?.startsWith('opencode.json#unknown_'),
    );
    expect(unknown.length).toBe(256);
  });

  it('records declared instructions, references, and skills opaquely, never persisting the target', async () => {
    const fixture = await makeFixture();
    const observed = await collect(fixture, CONSENTED);

    const first = byPath(observed.elements, '.opencode/opencode.jsonc#instructions.0');
    expect(first).toMatchObject({ native: { kind: 'instructions' }, inspectability: 'opaque' });
    expect(first.metadata['declaredTargetKind']).toBe('path');
    expect(
      byPath(observed.elements, '.opencode/opencode.jsonc#instructions.1').metadata[
        'declaredTargetKind'
      ],
    ).toBe('url');
    expect(
      byPath(observed.elements, '.opencode/opencode.jsonc#instructions.2').metadata[
        'declaredTargetKind'
      ],
    ).toBe('glob');

    // `references` is an object keyed by alias (#150). The object's own key
    // decides the family, so `{ path }` is never a repository.
    const referenceKind = (fragment: string): string =>
      byPath(observed.elements, `.opencode/opencode.jsonc#${fragment}`).metadata[
        'declaredTargetKind'
      ] as string;
    expect(referenceKind('references.0.refpath')).toBe('path');
    expect(referenceKind('references.1.refrel')).toBe('path');
    expect(referenceKind('references.2.refabs')).toBe('absolute-path');
    expect(referenceKind('references.3.refglob')).toBe('glob');
    expect(referenceKind('references.4.refrepo')).toBe('repository');
    expect(referenceKind('references.5.repshort')).toBe('repository');
    expect(referenceKind('references.6.refgit')).toBe('repository');
    expect(referenceKind('references.7.refbad')).toBe('other');
    expect(
      byPath(observed.elements, '.opencode/opencode.jsonc#references.0.refpath').native.kind,
    ).toBe('references');

    // `skills` paths/urls are declared sources (#151).
    expect(byPath(observed.elements, '.opencode/opencode.jsonc#skills.paths.0').native.kind).toBe(
      'skills',
    );
    expect(
      byPath(observed.elements, '.opencode/opencode.jsonc#skills.paths.0').metadata[
        'declaredTargetKind'
      ],
    ).toBe('path');
    expect(
      byPath(observed.elements, '.opencode/opencode.jsonc#skills.urls.0').metadata[
        'declaredTargetKind'
      ],
    ).toBe('url');

    // The secret-bearing URL never reaches the snapshot.
    expect(JSON.stringify(observed.elements)).not.toContain(SECRET_SENTINEL);
  });

  it('records an array-form references value as unsupported, not dropped', async () => {
    const fixture = await makeFixture();
    await writeFile(
      join(fixture.root, 'opencode.json'),
      JSON.stringify({ references: ['../refs'] }),
    );

    const observed = await collect(fixture, CONSENTED);

    expect(byPath(observed.elements, 'opencode.json#references')).toMatchObject({
      status: 'unsupported',
    });
  });

  it('records a malformed skills key visibly instead of dropping it', async () => {
    const fixture = await makeFixture();
    await writeFile(
      join(fixture.root, 'opencode.json'),
      JSON.stringify({ skills: { paths: './x', weird: [] } }),
    );

    const observed = await collect(fixture, CONSENTED);

    expect(byPath(observed.elements, 'opencode.json#skills.paths')).toMatchObject({
      status: 'unsupported',
    });
    expect(byPath(observed.elements, 'opencode.json#skills.1.weird')).toMatchObject({
      status: 'unsupported',
    });
  });
});

describe('collectOpencodeHarness element directories', () => {
  it('splits agents by mode and maps the other directories', async () => {
    const fixture = await makeFixture();
    const observed = await collect(fixture, CONSENTED);

    expect(byPath(observed.elements, '.opencode/agent/reviewer.md').native.kind).toBe('subagents');
    expect(byPath(observed.elements, '.opencode/agent/primary.md').native.kind).toBe('agents');
    expect(byPath(observed.elements, '.opencode/agent/primary.md').metadata['agentMode']).toBe(
      'primary',
    );
    // No frontmatter → the conservative subagent default.
    expect(byPath(observed.elements, '.opencode/agent/bare.md').native.kind).toBe('subagents');
    expect(byPath(observed.elements, '.opencode/command/deploy.md').native.kind).toBe('commands');
    expect(byPath(observed.elements, '.opencode/skill/dup/SKILL.md').native.kind).toBe('skills');
    expect(byPath(observed.elements, '.opencode/plugins/local.ts').native.kind).toBe('plugin');
    expect(byPath(observed.elements, '.opencode/tool/mytool.ts').native.kind).toBe('tools');
    // The legacy `mode(s)/` directory loads as primary agents (#149); a
    // declared mode is honored, and `all` stays in the conservative bucket.
    expect(byPath(observed.elements, '.opencode/mode/legacy.md').native.kind).toBe('agents');
    expect(byPath(observed.elements, '.opencode/mode/submode.md').native.kind).toBe('subagents');
    expect(byPath(observed.elements, '.opencode/mode/allmode.md').native.kind).toBe('subagents');
  });

  it('records cross-runtime skills with their compat scope', async () => {
    const fixture = await makeFixture();
    const observed = await collect(fixture, CONSENTED);

    expect(byPath(observed.elements, '.claude/skills/compat/SKILL.md').native.scope).toBe(
      'claude-compat',
    );
    expect(byPath(observed.elements, '.agents/skills/agentskill/SKILL.md').native.scope).toBe(
      'agents-compat',
    );
    expect(byPath(observed.elements, '~/.claude/skills/uclaude/SKILL.md').native.scope).toBe(
      'claude-compat',
    );
    expect(byPath(observed.elements, '~/.agents/skills/uagents/SKILL.md').native.scope).toBe(
      'agents-compat',
    );
  });

  it('does not follow a symlinked command and records an unreadable command', async () => {
    const fixture = await makeFixture();
    const observed = await collect(fixture, CONSENTED);

    expect(byPath(observed.elements, '.opencode/command/link.md')).toMatchObject({
      status: 'skipped',
      reason: 'symlink-not-followed',
    });
    expect(byPath(observed.elements, '.opencode/command/broken.md')).toMatchObject({
      status: 'unreadable',
      reason: 'unreadable',
    });
    // A non-candidate symlink is not recorded as an instruction.
    expect(paths(observed.elements)).not.toContain('elsewhere');
  });

  it('emits a duplicate-name diagnostic when a skill name is defined twice', async () => {
    const fixture = await makeFixture();
    const observed = await collect(fixture, CONSENTED);

    const duplicate = observed.diagnostics.find(
      (entry) => entry.code === 'duplicate-element-name' && entry.message.includes('"dup"'),
    );
    expect(duplicate).toBeDefined();
    expect(duplicate?.message).toContain('.opencode/skill/dup/SKILL.md');
  });

  it('treats primary agents and subagents as one collision namespace', async () => {
    const fixture = await makeFixture();
    await writeFile(
      join(fixture.root, '.opencode', 'agent', 'dupagent.md'),
      ['---', 'mode: subagent', '---', 'body', ''].join('\n'),
    );
    await writeFile(
      join(fixture.home, '.config', 'opencode', 'agent', 'dupagent.md'),
      ['---', 'mode: primary', '---', 'body', ''].join('\n'),
    );

    const observed = await collect(fixture, CONSENTED);

    const duplicate = observed.diagnostics.find(
      (entry) => entry.code === 'duplicate-element-name' && entry.message.includes('"dupagent"'),
    );
    expect(duplicate?.message).toContain('agent name');
  });

  it('redacts a secret-bearing plugin spec and flags two config forms', async () => {
    const fixture = await makeFixture();
    const secret = 'sk-ant-PLUGIN-EXFIL-0123456789';
    await writeFile(
      join(fixture.root, '.opencode', 'opencode.json'),
      JSON.stringify({
        plugin: [`https://plugins.example.com/install?token=${secret}`, `pkg?secret=${secret}`],
      }),
    );

    const observed = await collect(fixture, CONSENTED);

    expect(JSON.stringify(observed.elements)).not.toContain(secret);
    // A URL/path plugin specifier is persisted as its kind, not as a value.
    const plugin = byPath(observed.elements, '.opencode/opencode.json#plugin');
    expect(plugin.metadata['pluginTargetKinds']).toContain('url');
    expect(plugin.metadata['pluginNames']).toEqual([]);
    expect(observed.diagnostics.map((entry) => entry.code)).toContain('ambiguous-config-form');
  });
});

describe('collectOpencodeHarness layers and limits', () => {
  it('records the managed, remote, MDM, and builtin layers', async () => {
    const fixture = await makeFixture();
    const observed = await collect(fixture, CONSENTED);

    const managed = byPath(observed.elements, join(fixture.managed, 'opencode.json') + '#model');
    expect(managed.native).toMatchObject({ origin: 'managed', scope: 'managed-file' });
    expect(managed.metadata['model']).toBe('managed-model');

    const remote = observed.elements.find((element) => element.native.scope === 'remote-org');
    expect(remote).toMatchObject({ native: { origin: 'unknown' }, inspectability: 'opaque' });

    const mdm = observed.elements.find((element) => element.native.scope === 'managed-preferences');
    expect(mdm).toMatchObject({ inspectability: 'opaque' });

    const builtin = observed.elements.find(
      (element) => element.native.kind === 'runtime-provided-instructions',
    );
    expect(builtin?.source.path).toBe('(builtin) opencode instruction layers');
  });

  it('carries the default-layout limit as a diagnostic', async () => {
    const fixture = await makeFixture();
    const observed = await collect(fixture, CONSENTED);

    expect(observed.diagnostics.map((entry) => entry.code)).toContain('default-layout-only');
  });
});

describe('collectOpencodeHarness user instruction fallback', () => {
  it('falls back to ~/.claude/CLAUDE.md when the config dir has no AGENTS.md', async () => {
    const fixture = await makeFixture();
    // Remove the config-dir AGENTS.md so the fallback is reached.
    await rm(join(fixture.home, '.config', 'opencode', 'AGENTS.md'), { force: true });
    await writeFile(join(fixture.home, '.claude', 'CLAUDE.md'), '# claude fallback\n');

    const observed = await collect(fixture, CONSENTED);

    const fallback = byPath(observed.elements, '~/.claude/CLAUDE.md');
    expect(fallback.native).toMatchObject({ origin: 'user', scope: 'claude-compat' });
  });
});
