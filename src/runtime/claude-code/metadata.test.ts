import { describe, expect, it } from 'vitest';
import { filterToAllowlist } from '../../discovery/metadata.js';
import { CLAUDE_CODE_SAFE_METADATA_ALLOWLIST } from './metadata.js';

describe('CLAUDE_CODE_SAFE_METADATA_ALLOWLIST', () => {
  it('keeps allowlisted structural fields and drops unknown ones', () => {
    const filtered = filterToAllowlist(
      {
        format: 'md',
        hookMatchers: ['startup'],
        pluginNames: ['market/plug'],
        apiKey: 'sk-ant-secret',
        rawContent: 'raw instruction text',
      },
      CLAUDE_CODE_SAFE_METADATA_ALLOWLIST,
    );
    expect(filtered).toEqual({
      format: 'md',
      hookMatchers: ['startup'],
      pluginNames: ['market/plug'],
    });
  });
});
