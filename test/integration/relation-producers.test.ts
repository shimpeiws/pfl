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
  return resolved.relations.map((relation) => relation.type);
}

describe('relation producers', () => {
  it('produces every declared relation type across the shipped fixtures', async () => {
    const produced = new Set<string>();
    for (const runtime of ['claude', 'codex'] as const) {
      for (const type of await relationTypesFor(runtime)) produced.add(type);
    }

    expect([...produced].sort()).toEqual([...RELATION_TYPES].sort());
  });
});
