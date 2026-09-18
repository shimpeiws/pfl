import { rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ObservedSnapshot } from '../../src/core/observed.js';
import { resolveProjectContext } from '../../src/discovery/project-identity.js';
import { collectClaudeCodeHarness } from '../../src/runtime/claude-code/discovery.js';
import { collectCodexHarness } from '../../src/runtime/codex/discovery.js';
import { collectOpencodeHarness } from '../../src/runtime/opencode/discovery.js';
import type { AccessPolicy, ProjectContext } from '../../src/runtime/types.js';
import { materialize, type FixtureRuntime, type Materialized } from '../fixtures/materialize.js';

/**
 * The consent choke point (roadmap M8 #85). Every read outside the project is
 * classified into a scope, and the scope decides it in one place. With the
 * install scope alone the user harness must not appear; with the user scope
 * alone the installation version must not. Reverting the gate (ignoring the
 * policy) would bring the forbidden elements back and fail here.
 *
 * The managed scope is a system location, so the Claude harness is collected
 * with an injected empty base rather than the real `/Library`.
 */

const materialized: Materialized[] = [];

afterEach(async () => {
  await Promise.all(
    materialized.splice(0).map((m) => rm(m.base, { recursive: true, force: true, maxRetries: 3 })),
  );
});

const CLOSED: AccessPolicy = { user: false, install: false, grantedScopes: [] };
const USER: AccessPolicy = { user: true, install: false, grantedScopes: ['claude-code:user'] };
const INSTALL: AccessPolicy = { user: false, install: true, grantedScopes: [] };

/** Any path that is not relative to the project root: `~/…`, `../…`, or absolute. */
function outsideProjectPaths(observed: ObservedSnapshot): string[] {
  return observed.elements
    .map((element) => element.source.path)
    .filter((path): path is string => path !== undefined)
    .filter((path) => path.startsWith('~/') || path.startsWith('../') || isAbsolute(path));
}

function collect(
  runtime: FixtureRuntime,
  project: ProjectContext,
  m: Materialized,
  access: AccessPolicy,
) {
  if (runtime === 'claude') {
    return collectClaudeCodeHarness(project, access, m.home, join(m.home, 'managed'), '');
  }
  if (runtime === 'codex') return collectCodexHarness(project, access, m.home, '');
  return collectOpencodeHarness(project, access, m.home, join(m.home, 'managed'), '');
}

describe.each<FixtureRuntime>(['claude', 'codex', 'opencode'])(
  '%s consent choke point',
  (runtime) => {
    it('serves nothing out of project without a grant', async () => {
      const m = await materialize(runtime);
      materialized.push(m);
      const project = await resolveProjectContext(m.projectRoot);

      const observed = await collect(runtime, project, m, CLOSED);

      expect(outsideProjectPaths(observed)).toEqual([]);
      expect(observed.runtime.version).toBeNull();
      const codes = observed.diagnostics.map((entry) => entry.code);
      expect(codes).toContain('consent-not-granted:install');
      expect(codes).toContain('consent-not-granted:user');
    });

    it('serves install metadata without the user harness', async () => {
      const m = await materialize(runtime);
      materialized.push(m);
      const project = await resolveProjectContext(m.projectRoot);

      const observed = await collect(runtime, project, m, INSTALL);

      // OpenCode has no installer-managed version source this adapter reads, and
      // the fixture home has no Homebrew/PATH install, so a hermetic run cannot
      // resolve a version. The invariant under test is scope separation, not that
      // every runtime has a detectable fixture install.
      if (runtime === 'opencode') expect(observed.runtime.version).toBeNull();
      else expect(observed.runtime.version).not.toBeNull();
      expect(outsideProjectPaths(observed)).toEqual([]);
      // The grant took effect (no install-scope denial) and the user scope is
      // still closed. This is the discriminating assertion for every runtime,
      // including one whose version cannot be resolved from a fixture.
      const codes = observed.diagnostics.map((entry) => entry.code);
      expect(codes).not.toContain('consent-not-granted:install');
      expect(codes).toContain('consent-not-granted:user');
    });

    it('serves the user harness without install metadata', async () => {
      const m = await materialize(runtime);
      materialized.push(m);
      const project = await resolveProjectContext(m.projectRoot);

      const observed = await collect(runtime, project, m, USER);

      expect(outsideProjectPaths(observed).length).toBeGreaterThan(0);
      expect(observed.runtime.version).toBeNull();
      const codes = observed.diagnostics.map((entry) => entry.code);
      expect(codes).not.toContain('consent-not-granted:user');
      expect(codes).toContain('consent-not-granted:install');
    });
  },
);
