import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { runInspect } from '../../src/cli/inspect.js';
import { RELATION_TYPES } from '../../src/core/resolved.js';
import { resolveProjectContext } from '../../src/discovery/project-identity.js';
import { readLatestPointer, readResolvedSnapshot } from '../../src/snapshot/store.js';
import type { Logger } from '../../src/util/logger.js';
import {
  RUNTIME_IDS,
  grantConsent,
  materialize,
  type FixtureRuntime,
  type Materialized,
} from '../fixtures/materialize.js';

/**
 * The relation-type freeze (issue #83, docs/design/relation-types.md). Every
 * type declared in `RELATION_TYPES` must be produced by a real resolution, and
 * a fixture must exercise each producer. This is what stops a withdrawn type
 * from being re-declared without a producer, and a produced type from losing
 * its only producer silently.
 */

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const materialized: Materialized[] = [];

afterEach(async () => {
  await Promise.all(
    materialized.splice(0).map((m) => rm(m.base, { recursive: true, force: true, maxRetries: 3 })),
  );
});

async function relationTypesFor(runtime: FixtureRuntime): Promise<string[]> {
  const m = await materialize(runtime);
  materialized.push(m);
  await grantConsent(m.home, runtime);
  await runInspect(
    m.projectRoot,
    { runtime: RUNTIME_IDS[runtime], home: m.home, pathValue: '', interactive: false },
    silent,
  );
  const projectId = (await resolveProjectContext(m.projectRoot)).id;
  const pointer = await readLatestPointer(projectId, m.home);
  if (pointer === null) throw new Error(`no latest pointer after inspecting ${runtime}`);
  const resolved = await readResolvedSnapshot(projectId, pointer.resolved, m.home);
  return [...new Set(resolved.relations.map((relation) => relation.type))];
}

/**
 * Where each declared type is produced. Pinning it per runtime makes the test
 * falsifiable: removing a producer (or moving it to the other adapter) fails
 * even if the union of produced types happens to stay the same.
 */
const EXPECTED: Record<FixtureRuntime, readonly string[]> = {
  // Claude: settings-key precedence and same-directory CLAUDE.local shadowing
  // produce `shadows`; accumulating instruction layers produce
  // `accumulates-with`.
  claude: ['accumulates-with', 'shadows'],
  // Codex: `AGENTS.override.md` produces `overrides` and `shadows`;
  // accumulating instruction layers produce `accumulates-with`.
  codex: ['accumulates-with', 'overrides', 'shadows'],
  // OpenCode: accumulating instruction layers produce `accumulates-with`; the
  // adapter models no cross-source override or shadow relation.
  opencode: ['accumulates-with'],
};

const RUNTIMES = ['claude', 'codex', 'opencode'] as const;

describe('relation producers', () => {
  it('produces exactly the expected relation types per runtime', async () => {
    for (const runtime of RUNTIMES) {
      expect([...(await relationTypesFor(runtime))].sort()).toEqual([...EXPECTED[runtime]].sort());
    }
  });

  it('covers every declared relation type across the shipped fixtures', async () => {
    const produced = new Set<string>();
    for (const runtime of RUNTIMES) {
      for (const type of await relationTypesFor(runtime)) produced.add(type);
    }

    expect([...produced].sort()).toEqual([...RELATION_TYPES].sort());
  });
});
