import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectContext } from '../../src/runtime/types.js';
import {
  detectClaudeCode,
  VERIFIED_CLAUDE_CODE_RANGE,
} from '../../src/runtime/claude-code/detect.js';
import { detectCodex, VERIFIED_CODEX_RANGE } from '../../src/runtime/codex/detect.js';
import { getAdapter } from '../../src/runtime/registry.js';
import { versionPosition } from '../../src/runtime/version-compat.js';
import { materialize, type Materialized } from '../fixtures/materialize.js';

/**
 * Fixture-backed detection (roadmap §5 M7, issue #76). The committed fixture
 * trees carry the installer-managed layout, so a runtime layout change fails
 * here instead of silently invalidating the source comment that claims a
 * verified range. `PATH` is injected empty so the host's own installs are never
 * read.
 */

const materialized: Materialized[] = [];

afterEach(async () => {
  await Promise.all(
    materialized.splice(0).map((m) => rm(m.base, { recursive: true, force: true, maxRetries: 3 })),
  );
});

async function fixture(runtime: 'claude' | 'codex'): Promise<Materialized> {
  const m = await materialize(runtime);
  materialized.push(m);
  return m;
}

const PROJECT: ProjectContext = { id: 'proj', displayName: 'owner/repo', root: '/repo' };

describe('fixture-backed runtime detection', () => {
  it('pins the Claude Code fixture version inside the verified range', async () => {
    const m = await fixture('claude');

    const detection = await detectClaudeCode(m.home, '');

    expect(detection.installed).toBe('yes');
    expect(detection.version).toBe('2.1.272');
    expect(versionPosition(detection.version, VERIFIED_CLAUDE_CODE_RANGE)).toBe('within');
    expect(detection.runtimeCompatibility).toBe('verified');
  });

  it('pins the Codex fixture version inside the verified range', async () => {
    const m = await fixture('codex');

    const detection = await detectCodex(m.home, '');

    expect(detection.installed).toBe('yes');
    expect(detection.version).toBe('0.154.0');
    expect(versionPosition(detection.version, VERIFIED_CODEX_RANGE)).toBe('within');
    expect(detection.runtimeCompatibility).toBe('verified');
  });
});

describe.each(['claude-code', 'codex'] as const)('%s detection without consent', (runtime) => {
  it('reports installed unknown, not no, when it could not look', async () => {
    const m = await fixture(runtime === 'claude-code' ? 'claude' : 'codex');

    const detection = await getAdapter(runtime).detect(
      PROJECT,
      { allowOutsideProject: false, grantedScopes: [] },
      m.home,
      '',
    );

    expect(detection.installed).toBe('unknown');
    expect(detection.version).toBeNull();
    expect(detection.runtimeCompatibility).toBe('unverified');
    expect(detection.diagnostics.map((d) => d.code)).toContain('consent-not-granted');
  });
});
