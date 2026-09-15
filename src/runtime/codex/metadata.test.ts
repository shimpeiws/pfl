import { describe, expect, it } from 'vitest';
import { filterToAllowlist } from '../../discovery/metadata.js';
import { CODEX_SAFE_METADATA_ALLOWLIST } from './metadata.js';

describe('CODEX_SAFE_METADATA_ALLOWLIST', () => {
  it('keeps allowlisted structural fields and drops unknown ones', () => {
    const filtered = filterToAllowlist(
      {
        kind: 'mcp-configuration',
        approvalMode: 'on-request',
        apiKey: 'sk-proj-secret',
        rawContent: 'raw instruction text',
      },
      CODEX_SAFE_METADATA_ALLOWLIST,
    );
    expect(filtered).toEqual({ kind: 'mcp-configuration', approvalMode: 'on-request' });
  });
});
