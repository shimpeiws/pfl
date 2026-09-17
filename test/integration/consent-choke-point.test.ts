import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { ObservedSnapshot } from '../../src/core/observed.js';
import { resolveProjectContext } from '../../src/discovery/project-identity.js';
import { getAdapter } from '../../src/runtime/registry.js';
import type { AccessPolicy } from '../../src/runtime/types.js';
import {
  RUNTIME_IDS,
  materialize,
  type FixtureRuntime,
  type Materialized,
} from '../fixtures/materialize.js';

/**
 * The consent choke point (roadmap M8 #85). Every read outside the project is
 * classified into a scope, and the scope decides it in one place. With no grant
 * a discovery must yield no element sourced outside the project and no version;
 * with the user grant the user harness appears. Reverting the gate (ignoring
 * the policy) would bring the user elements back into the closed run and fail
 * here.
 */

const materialized: Materialized[] = [];

afterEach(async () => {
  await Promise.all(
    materialized.splice(0).map((m) => rm(m.base, { recursive: true, force: true, maxRetries: 3 })),
  );
});

const CLOSED: AccessPolicy = { user: false, install: false, grantedScopes: [] };
const USER: AccessPolicy = { user: true, install: false, grantedScopes: ['user:user'] };

function outsideProjectPaths(observed: ObservedSnapshot): string[] {
  return observed.elements
    .map((element) => element.source.path)
    .filter((path): path is string => path !== undefined)
    .filter((path) => path.startsWith('~/') || path.startsWith('../'));
}

describe.each<FixtureRuntime>(['claude', 'codex'])('%s consent choke point', (runtime) => {
  it('serves no out-of-project element and no version without a grant', async () => {
    const m = await materialize(runtime);
    materialized.push(m);
    const project = await resolveProjectContext(m.projectRoot);
    const adapter = getAdapter(RUNTIME_IDS[runtime]);

    const observed = await adapter.discover(project, CLOSED, m.home, '');

    expect(outsideProjectPaths(observed)).toEqual([]);
    expect(observed.runtime.version).toBeNull();
    // The absence is recorded, not silently presented as an empty harness.
    expect(observed.diagnostics.some((d) => d.code === 'consent-not-granted')).toBe(true);
  });

  it('serves the user harness once the user scope is granted', async () => {
    const m = await materialize(runtime);
    materialized.push(m);
    const project = await resolveProjectContext(m.projectRoot);
    const adapter = getAdapter(RUNTIME_IDS[runtime]);

    const observed = await adapter.discover(project, USER, m.home, '');

    expect(outsideProjectPaths(observed).length).toBeGreaterThan(0);
  });
});
