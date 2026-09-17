import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_CODES } from '../../src/cli/exit-codes.js';
import { runInspect } from '../../src/cli/inspect.js';
import { resolveProjectContext } from '../../src/discovery/project-identity.js';
import { readLatestPointer, readObservedSnapshot } from '../../src/snapshot/store.js';
import type { Logger } from '../../src/util/logger.js';
import {
  RUNTIME_IDS,
  materialize,
  readStoreArtifacts,
  type FixtureRuntime,
  type Materialized,
} from '../fixtures/materialize.js';

const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const materialized: Materialized[] = [];

afterEach(async () => {
  await Promise.all(
    materialized.splice(0).map((m) => rm(m.base, { recursive: true, force: true, maxRetries: 3 })),
  );
});

const USER_SENTINEL: Record<FixtureRuntime, string> = {
  claude: 'SENTINEL_CLAUDE_USER',
  codex: 'SENTINEL_CODEX_USER',
};

describe.each<FixtureRuntime>(['claude', 'codex'])('%s consent boundary', (runtime) => {
  it('opens nothing outside the project when consent is denied', async () => {
    const m = await materialize(runtime);
    materialized.push(m);

    await runInspect(
      m.projectRoot,
      {
        runtime: RUNTIME_IDS[runtime],
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

    const artifacts = await readStoreArtifacts(m.home);
    // Positive control: a negative assertion over an empty store proves nothing.
    expect(artifacts.length).toBeGreaterThan(0);
    expect(artifacts).not.toContain(USER_SENTINEL[runtime]);
  });

  it('fails closed in a non-interactive run without consent', async () => {
    const m = await materialize(runtime);
    materialized.push(m);

    await expect(
      runInspect(
        m.projectRoot,
        { runtime: RUNTIME_IDS[runtime], home: m.home, interactive: false },
        silent,
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.CONSENT_REQUIRED });
  });

  it('does not read an out-of-project .git file before consent', async () => {
    const m = await materialize(runtime);
    materialized.push(m);
    const outsideGit = join(m.outsideDir, 'gitdir');
    await mkdir(outsideGit, { recursive: true });
    await writeFile(
      join(outsideGit, 'config'),
      '[remote "origin"]\n\turl = git@github.com:SECRET_LEAK_REMOTE/repo.git\n',
    );
    await writeFile(join(m.projectRoot, '.git'), `gitdir: ${outsideGit}\n`);

    await runInspect(
      m.projectRoot,
      {
        runtime: RUNTIME_IDS[runtime],
        home: m.home,
        interactive: true,
        io: { readAnswer: async () => 'n' },
      },
      silent,
    );

    // The gitdir target is out of project: it must not have been read, so its
    // remote never reaches the store.
    const artifacts = await readStoreArtifacts(m.home);
    expect(artifacts.length).toBeGreaterThan(0);
    expect(artifacts).not.toContain('SECRET_LEAK_REMOTE');
  });
});
