import { describe, expect, it } from 'vitest';
import {
  MAX_TOML_ARRAY_ITEMS,
  MAX_TOML_SCALAR_LENGTH,
  MAX_TOML_SECTION_DEPTH,
} from '../../limits.js';
import { readTomlFacts } from './toml.js';

function sectionNames(facts: ReturnType<typeof readTomlFacts>, section: string): string[] {
  return [...(facts.root.tables.get(section)?.tables.keys() ?? [])];
}

describe('readTomlFacts', () => {
  it('reads top-level scalars of every supported type', () => {
    const facts = readTomlFacts(
      [
        'approval_policy = "on-request"',
        'network = true',
        'turns = 42',
        'ratio = 1.5',
        'off = false',
        '',
      ].join('\n'),
    );

    expect(facts.malformed).toBe(false);
    expect(facts.root.scalars.get('approval_policy')).toBe('on-request');
    expect(facts.root.scalars.get('network')).toBe(true);
    expect(facts.root.scalars.get('turns')).toBe(42);
    expect(facts.root.scalars.get('ratio')).toBe(1.5);
    expect(facts.root.scalars.get('off')).toBe(false);
  });

  it('reads section-scoped scalars rather than skipping them', () => {
    const facts = readTomlFacts(
      ['[sandbox_workspace_write]', 'network_access = true', 'model = "not-top-level"', ''].join(
        '\n',
      ),
    );

    expect(facts.root.scalars.size).toBe(0);
    const section = facts.root.tables.get('sandbox_workspace_write');
    expect(section?.scalars.get('network_access')).toBe(true);
    expect(section?.scalars.get('model')).toBe('not-top-level');
  });

  it('reads single-line and multi-line arrays of scalars', () => {
    const facts = readTomlFacts(
      [
        'notify = ["/bin/notify", "turn-ended"]',
        '[sandbox_workspace_write]',
        'writable_roots = [',
        '  "/first",',
        '  "/second",',
        ']',
        '',
      ].join('\n'),
    );

    expect(facts.root.scalars.get('notify')).toEqual(['/bin/notify', 'turn-ended']);
    expect(facts.root.tables.get('sandbox_workspace_write')?.scalars.get('writable_roots')).toEqual(
      ['/first', '/second'],
    );
  });

  it('collects named sections, including quoted names that contain a dot', () => {
    const facts = readTomlFacts(
      [
        '[mcp_servers.node_repl]',
        'command = "node"',
        '[plugins."a@market"]',
        'enabled = true',
        '[mcp_servers."foo.bar"]',
        '[marketplaces.local]',
        'source_type = "local"',
        '',
      ].join('\n'),
    );

    expect(sectionNames(facts, 'mcp_servers')).toEqual(['node_repl', 'foo.bar']);
    expect(sectionNames(facts, 'plugins')).toEqual(['a@market']);
    expect(sectionNames(facts, 'marketplaces')).toEqual(['local']);
  });

  it('reads a quoted project path and profile overrides as distinct tables', () => {
    const facts = readTomlFacts(
      [
        '[projects."/Users/shin/src/repo"]',
        'trust_level = "trusted"',
        '[profiles.fast]',
        'approval_policy = "never"',
        'sandbox_mode = "read-only"',
        '',
      ].join('\n'),
    );

    expect(
      facts.root.tables
        .get('projects')
        ?.tables.get('/Users/shin/src/repo')
        ?.scalars.get('trust_level'),
    ).toBe('trusted');
    const profile = facts.root.tables.get('profiles')?.tables.get('fast');
    expect(profile?.scalars.get('approval_policy')).toBe('never');
    expect(profile?.scalars.get('sandbox_mode')).toBe('read-only');
  });

  it('strips comments without touching strings that contain #', () => {
    const facts = readTomlFacts('model = "gpt-5" # the model\nurl = "https://x/#frag"\n');

    expect(facts.root.scalars.get('model')).toBe('gpt-5');
    expect(facts.root.scalars.get('url')).toBe('https://x/#frag');
  });

  it('handles escaped quotes inside a string', () => {
    expect(readTomlFacts('name = "a\\"b" # comment\n').root.scalars.get('name')).toBe('a"b');
  });

  it('records an assignment with trailing content as malformed', () => {
    const facts = readTomlFacts('model = "m" extra\n');

    expect(facts.root.scalars.has('model')).toBe(false);
    expect(facts.malformed).toBe(true);
  });

  it('takes the last value for a duplicated key', () => {
    expect(readTomlFacts('model = "a"\nmodel = "b"\n').root.scalars.get('model')).toBe('b');
  });
});

describe('readTomlFacts bounded input (hostile corpus)', () => {
  it('does not hang or throw on an unterminated section header', () => {
    const facts = readTomlFacts(`[${'a.'.repeat(200_000)}`);

    expect(facts.malformed).toBe(true);
    expect(facts.root.tables.size).toBe(0);
  }, 2000);

  it('does not hang on a large unterminated multi-line array', () => {
    const lines = ['x = ['];
    for (let index = 0; index < 20_000; index += 1) lines.push(`  "value-${index}",`);
    const facts = readTomlFacts(lines.join('\n'));

    expect(facts.malformed).toBe(true);
    expect(facts.root.scalars.has('x')).toBe(false);
  }, 3000);

  it('does not throw on malformed sections and control characters', () => {
    const text = '[\n]\n[[\nmodel = "m"\n\u0000\u0007\nkey = \n';
    expect(() => readTomlFacts(text)).not.toThrow();
  }, 2000);

  it('ignores an unterminated string', () => {
    const facts = readTomlFacts('model = "unterminated\n');
    expect(facts.root.scalars.has('model')).toBe(false);
    expect(facts.malformed).toBe(true);
  });

  it('caps section depth and reports malformed', () => {
    const path = Array.from({ length: MAX_TOML_SECTION_DEPTH + 2 }, (_, i) => `s${i}`).join('.');
    const facts = readTomlFacts(`[${path}]\nkey = "v"\n`);

    expect(facts.root.tables.size).toBe(0);
    expect(facts.malformed).toBe(true);
  });

  it('caps array items and reports malformed', () => {
    const items = Array.from({ length: MAX_TOML_ARRAY_ITEMS + 5 }, (_, i) => `"i${i}"`);
    const facts = readTomlFacts(`writable_roots = [${items.join(', ')}]\n`);

    expect(facts.root.scalars.get('writable_roots')).toHaveLength(MAX_TOML_ARRAY_ITEMS);
    expect(facts.malformed).toBe(true);
  });

  it('caps scalar length and reports malformed', () => {
    const facts = readTomlFacts(`value = "${'x'.repeat(MAX_TOML_SCALAR_LENGTH + 50)}"\n`);

    expect((facts.root.scalars.get('value') as string).length).toBe(MAX_TOML_SCALAR_LENGTH);
    expect(facts.malformed).toBe(true);
  });

  it('handles a very long valid scalar line without failing', () => {
    const facts = readTomlFacts(`[mcp_servers.s]\nvalue = "${'x'.repeat(200)}"\n`);

    expect(typeof facts.root.tables.get('mcp_servers')?.tables.get('s')?.scalars.get('value')).toBe(
      'string',
    );
  }, 2000);

  it('handles CRLF line endings', () => {
    const facts = readTomlFacts('model = "m"\r\nother = "o"\r\n');
    expect(facts.root.scalars.get('model')).toBe('m');
    expect(facts.root.scalars.get('other')).toBe('o');
  });

  it('collects many server sections', () => {
    const text = Array.from({ length: 500 }, (_, index) => `[mcp_servers.s${index}]`).join('\n');
    expect(sectionNames(readTomlFacts(text), 'mcp_servers')).toHaveLength(500);
  });

  it('does not pollute Object.prototype from a __proto__ scalar or section', () => {
    const facts = readTomlFacts(
      ['__proto__ = "polluted"', '[mcp_servers.__proto__]', 'enabled = true', ''].join('\n'),
    );

    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(facts.root.scalars.has('__proto__')).toBe(true);
    expect(sectionNames(facts, 'mcp_servers')).toContain('__proto__');
  });
});
