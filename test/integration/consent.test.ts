import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_CODES } from '../../src/cli/exit-codes.js';
import { runInspect } from '../../src/cli/inspect.js';
import { resolveProjectContext } from '../../src/discovery/project-identity.js';
import { readLatestPointer, readObservedSnapshot } from '../../src/snapshot/store.js';
import type { Logger } from '../../src/util/logger.js';
import { materialize, readStoreArtifacts, type Materialized } from '../fixtures/materialize.js';

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const materialized: Materialized[] = [];

afterEach(async () => {
  await Promise.all(
    materialized.splice(0).map((m) => rm(m.base, { recursive: true, force: true, maxRetries: 3 })),
  );
});

describe('consent boundary', () => {
  it('opens nothing outside the project when consent is denied', async () => {
    const m = await materialize('claude');
    materialized.push(m);

    await runInspect(
      m.projectRoot,
      {
        runtime: 'claude-code',
        home: m.home,
        interactive: true,
        io: { readAnswer: async () => 'n' },
      },
      silent,
    );

    // No user-scope element was read, and the user-scope sentinel never reached disk.
    const projectId = (await resolveProjectContext(m.projectRoot)).id;
    const pointer = await readLatestPointer(projectId, m.home);
    if (pointer === null) throw new Error('expected a latest pointer');
    const observed = await readObservedSnapshot(projectId, pointer.observed, m.home);
    expect(observed.elements.some((element) => element.native.origin === 'user')).toBe(false);
    expect(await readStoreArtifacts(m.home)).not.toContain('SENTINEL_CLAUDE_USER');
  });

  it('fails closed in a non-interactive run without consent', async () => {
    const m = await materialize('claude');
    materialized.push(m);

    await expect(
      runInspect(
        m.projectRoot,
        { runtime: 'claude-code', home: m.home, interactive: false },
        silent,
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONSENT_REQUIRED });
  });
});
