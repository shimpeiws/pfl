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
});
