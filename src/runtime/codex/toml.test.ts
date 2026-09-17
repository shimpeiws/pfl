import { describe, expect, it } from 'vitest';
import { readTomlFacts } from './toml.js';

describe('readTomlFacts', () => {
  it('extracts top-level string scalars', () => {
    const facts = readTomlFacts('approval_policy = "on-request"\nmodel = "gpt-5.6"\n');
    expect(facts.values).toEqual({ approval_policy: 'on-request', model: 'gpt-5.6' });
  });

  it('ignores non-string values, arrays, and inline tables', () => {
    const facts = readTomlFacts(
      ['network_access = true', 'notify = ["a", "b"]', 'opts = { x = 1 }', 'model = "m"', ''].join(
        '\n',
      ),
    );
    expect(facts.values).toEqual({ model: 'm' });
  });

  it('does not read scalars that are inside a section', () => {
    const facts = readTomlFacts('[sandbox_workspace_write]\nmodel = "not-top-level"\n');
    expect(facts.values).toEqual({});
  });

  it('collects mcp_servers and plugins section names', () => {
    const facts = readTomlFacts(
      [
        '[mcp_servers.node_repl]',
        'command = "node"',
        '[plugins."a@market"]',
        'enabled = true',
        '',
      ].join('\n'),
    );
    expect(facts.mcpServers).toEqual(['node_repl']);
    expect(facts.plugins).toEqual(['a@market']);
  });

  it('strips comments without touching strings that contain #', () => {
    const facts = readTomlFacts('model = "gpt-5" # the model\nurl = "https://x/#frag"\n');
    expect(facts.values).toEqual({ model: 'gpt-5', url: 'https://x/#frag' });
  });

  it('handles escaped quotes inside a string', () => {
    const facts = readTomlFacts('name = "a\\"b" # comment\n');
    expect(facts.values).toEqual({ name: 'a"b' });
  });

  it('ignores an assignment with trailing content', () => {
    const facts = readTomlFacts('model = "m" extra\n');
    expect(facts.values).toEqual({});
  });

  it('reads quoted section names that contain a dot', () => {
    const facts = readTomlFacts('[mcp_servers."foo.bar"]\n[mcp_servers."baz.qux".env]\n');
    expect(facts.mcpServers).toEqual(['foo.bar', 'baz.qux']);
  });
});

describe('readTomlFacts pathological input (hostile corpus)', () => {
  // The parse-size ceiling (MAX_PARSE_BYTES) is enforced before this reader is
  // called (readTextFileGuarded), and is covered by the adapter's oversized
  // config.toml test; these cases are about the reader itself not hanging.
  it('ignores an unterminated string', () => {
    expect(readTomlFacts('model = "unterminated\n').values).toEqual({});
  });

  it('does not throw on malformed sections and control characters', () => {
    const text = '[\n]\n[[\nmodel = "m"\n\u0000\u0007\nkey = \n';
    expect(() => readTomlFacts(text)).not.toThrow();
  }, 2000);

  it('handles a very long single line without failing', () => {
    const facts = readTomlFacts(`value = "${'x'.repeat(200_000)}"\n`);
    expect(facts.values['value']?.length).toBe(200_000);
  }, 2000);

  it('handles CRLF line endings', () => {
    expect(readTomlFacts('model = "m"\r\nother = "o"\r\n').values).toEqual({
      model: 'm',
      other: 'o',
    });
  });

  it('collects many server sections', () => {
    const text = Array.from({ length: 500 }, (_, index) => `[mcp_servers.s${index}]`).join('\n');
    expect(readTomlFacts(text).mcpServers).toHaveLength(500);
  });

  it('does not pollute Object.prototype from a __proto__ scalar or section', () => {
    const facts = readTomlFacts(
      ['__proto__ = "polluted"', '[mcp_servers.__proto__]', 'enabled = true', ''].join('\n'),
    );

    expect(Object.getPrototypeOf(facts.values)).toBeNull();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('takes the last value for a duplicated top-level key', () => {
    expect(readTomlFacts('model = "a"\nmodel = "b"\n').values).toEqual({ model: 'b' });
  });
});
