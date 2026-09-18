import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runInspect } from '../../src/cli/inspect.js';
import { resolveProjectContext } from '../../src/discovery/project-identity.js';
import {
  observationsDir,
  readInterpretationForResolved,
  readLatestPointer,
  readObservedSnapshot,
} from '../../src/snapshot/store.js';
import type { Logger } from '../../src/util/logger.js';
import {
  RUNTIME_IDS,
  SECRETS,
  SENTINELS,
  fingerprintTree,
  grantConsent,
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

async function inspect(runtime: FixtureRuntime): Promise<Materialized> {
  const m = await materialize(runtime);
  materialized.push(m);
  await grantConsent(m.home, runtime);
  await runInspect(
    m.projectRoot,
    { runtime: RUNTIME_IDS[runtime], home: m.home, interactive: false },
    silent,
  );
  return m;
}

async function latestObserved(m: Materialized) {
  const projectId = (await resolveProjectContext(m.projectRoot)).id;
  const pointer = await readLatestPointer(projectId, m.home);
  if (pointer === null) throw new Error('expected a latest pointer after inspect');
  return {
    projectId,
    observed: await readObservedSnapshot(projectId, pointer.observed, m.home),
  };
}

describe.each<FixtureRuntime>(['claude', 'codex', 'opencode'])(
  '%s harness invariants',
  (runtime) => {
    it('is read-only: a full inspect changes nothing under the project, the user scope, or outside', async () => {
      const m = await materialize(runtime);
      materialized.push(m);
      await grantConsent(m.home, runtime);
      // The store under `~/.pfl` is the one thing a run may write; everything else
      // (project, the whole home except `.pfl`, and the out-of-project fixture)
      // must be untouched.
      const beforeProject = await fingerprintTree(m.projectRoot);
      const beforeHome = await fingerprintTree(m.home, { exclude: ['.pfl'] });
      const beforeOutside = await fingerprintTree(m.outsideDir);
      // Positive controls: each fingerprint actually covers entries, so an empty
      // comparison cannot pass vacuously.
      expect(beforeProject.size).toBeGreaterThan(0);
      expect(beforeHome.size).toBeGreaterThan(0);
      expect(beforeOutside.size).toBeGreaterThan(0);

      await runInspect(
        m.projectRoot,
        { runtime: RUNTIME_IDS[runtime], home: m.home, pathValue: '', interactive: false },
        silent,
      );

      expect(await fingerprintTree(m.projectRoot)).toEqual(beforeProject);
      expect(await fingerprintTree(m.home, { exclude: ['.pfl'] })).toEqual(beforeHome);
      expect(await fingerprintTree(m.outsideDir)).toEqual(beforeOutside);
    });

    it('never follows the symlink and records it once as skipped', async () => {
      const m = await inspect(runtime);
      const { observed } = await latestObserved(m);

      const links = observed.elements.filter(
        (element) => element.source.path === m.symlinkRelativePath,
      );
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ status: 'skipped', reason: 'symlink-not-followed' });
      expect(
        observed.elements.some((element) => (element.source.path ?? '').includes('leaked')),
      ).toBe(false);
    });

    it('never follows a symlinked settings file and records it once as skipped', async () => {
      const m = await inspect(runtime);
      const { observed } = await latestObserved(m);

      const links = observed.elements.filter(
        (element) => element.source.path === m.settingsSymlinkRelativePath,
      );
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({ status: 'skipped', reason: 'symlink-not-followed' });
      // The old unguarded read parsed the symlink target into a config element.
      expect(
        observed.elements.some((element) =>
          (element.source.path ?? '').startsWith(`${m.settingsSymlinkRelativePath}#`),
        ),
      ).toBe(false);
    });

    it('does not treat .mcp.json as an OpenCode MCP source', async () => {
      if (runtime !== 'opencode') return;
      const m = await inspect(runtime);
      const { observed } = await latestObserved(m);

      // The project `.mcp.json` is a Claude Code source, not an OpenCode one.
      expect(
        observed.elements.some((element) => (element.source.path ?? '').includes('.mcp.json')),
      ).toBe(false);
    });

    it('reads the OpenCode fixture config files at every declared scope', async () => {
      if (runtime !== 'opencode') return;
      const m = await inspect(runtime);
      const { observed } = await latestObserved(m);
      const paths = observed.elements.map((element) => element.source.path ?? '');

      // Positive control for the committed fixture tree: if a config file is
      // missing (or git-ignored, as `opencode.json` once was), these vanish and the
      // negative assertions above would pass vacuously. Project root, project
      // `.opencode/`, and user scope are each represented.
      expect(paths.some((path) => path.startsWith('opencode.json#'))).toBe(true);
      expect(paths.some((path) => path.startsWith('.opencode/opencode.jsonc#'))).toBe(true);
      expect(paths.some((path) => path.startsWith('~/.config/opencode/opencode.json#'))).toBe(true);
    });

    it('records unsupported and unreadable entries and reports partial completeness', async () => {
      const m = await inspect(runtime);
      const { observed } = await latestObserved(m);

      expect(observed.completeness).toBe('partial');
      expect(observed.elements.some((element) => element.status === 'unreadable')).toBe(true);
      expect(observed.diagnostics.some((diagnostic) => diagnostic.code === 'unreadable-file')).toBe(
        true,
      );
      // Only the Claude and OpenCode fixtures carry an item the adapter cannot
      // classify inside a known area (a Claude unknown file, an OpenCode unknown
      // config key); the Codex discovery areas are leaves. The OpenCode case is
      // pinned to its path so deleting the fixture key cannot leave it green.
      if (runtime === 'opencode') {
        expect(
          observed.elements
            .filter((element) => element.status === 'unsupported')
            .map((element) => element.source.path),
        ).toContain('.opencode/opencode.jsonc#sentinelKey');
      } else if (runtime === 'claude') {
        expect(observed.elements.some((element) => element.status === 'unsupported')).toBe(true);
      }
    });

    it('persists no raw content and no secrets', async () => {
      const m = await inspect(runtime);
      const artifacts = await readStoreArtifacts(m.home);

      // Positive control: a negative assertion over an empty store proves nothing,
      // and the artifact bodies (not only the pointer) must have been read.
      expect(artifacts.length).toBeGreaterThan(0);
      expect(artifacts).toContain('"schemaVersion"');
      for (const sentinel of SENTINELS) {
        expect(artifacts).not.toContain(sentinel);
      }
      for (const secret of SECRETS) {
        expect(artifacts).not.toContain(secret);
      }
    });

    it('stores interpretation text that carries no path or raw content', async () => {
      const m = await inspect(runtime);
      const projectId = (await resolveProjectContext(m.projectRoot)).id;
      const pointer = await readLatestPointer(projectId, m.home);
      if (pointer === null) throw new Error('expected a latest pointer after inspect');
      const interpretation = await readInterpretationForResolved(
        projectId,
        pointer.resolved,
        m.home,
      );
      if (interpretation === null) throw new Error('expected a stored interpretation');

      // Reasons and finding messages are templates over counts, enums, and
      // structural key names; none may carry a path or captured content. A
      // positive control keeps the check from passing over an empty set.
      const texts = [
        ...interpretation.elements.map((element) => element.reason),
        ...interpretation.findings.map((finding) => finding.message),
      ];
      expect(texts.length).toBeGreaterThan(0);
      for (const text of texts) {
        expect(text).not.toContain('/');
        expect(text).not.toContain('~');
        for (const sentinel of SENTINELS) expect(text).not.toContain(sentinel);
        for (const secret of SECRETS) expect(text).not.toContain(secret);
      }
    });

    it('keeps snapshots immutable across repeated runs', async () => {
      const m = await inspect(runtime);
      const projectId = (await resolveProjectContext(m.projectRoot)).id;
      const pointer = await readLatestPointer(projectId, m.home);
      if (pointer === null) throw new Error('expected a latest pointer after inspect');
      const firstPath = join(observationsDir(projectId, m.home), `${pointer.observed}.json`);
      const firstBytes = await readFile(firstPath, 'utf8');

      await runInspect(
        m.projectRoot,
        { runtime: RUNTIME_IDS[runtime], home: m.home, pathValue: '', interactive: false },
        silent,
      );

      expect(await readFile(firstPath, 'utf8')).toBe(firstBytes);
      const files = await readdir(observationsDir(projectId, m.home));
      expect(files).toHaveLength(2);
    });
  },
);

describe('no-execution guard', () => {
  // A text scan is a tripwire, not a proof: obfuscation (globalThis['ev'+'al'])
  // evades it, and type-position `import('./x')` would false-positive. It has
  // no false positives in `src` today, so it stays strict.
  const forbidden = [
    /child_process/,
    /\bexecSync\b/,
    /\bspawnSync\b/,
    /\bspawn\(/,
    /\bexecFile\(/,
    /\bexecFileSync\b/,
    /\beval\s*\(/,
    /\bFunction\s*\(/,
    /['"](?:node:)?vm['"]/,
    /worker_threads/,
    /\bcreateRequire\b/,
    /\bimport\s*\(/,
    /\brequire\s*\(/,
  ];

  it('flags a known-bad canary, so the patterns are not inert', () => {
    const canary = [
      'const a = child_process;',
      'eval("1");',
      'new Function("a");',
      'await import("./z");',
      'require("w");',
      'createRequire(x)("m");',
      'from "vm";',
      'worker_threads;',
    ].join('\n');

    expect(forbidden.filter((pattern) => pattern.test(canary)).length).toBeGreaterThanOrEqual(7);
  });

  it('never imports or calls a process-spawning or code-evaluating API in src', async () => {
    const scanned: string[] = [];
    const matches: string[] = [];

    async function walk(dir: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          scanned.push(full);
          const content = await readFile(full, 'utf8');
          for (const pattern of forbidden) {
            if (pattern.test(content)) matches.push(`${full}: ${String(pattern)}`);
          }
        }
      }
    }
    await walk(join(process.cwd(), 'src'));

    // Positive control: the walk actually found files to scan.
    expect(scanned.length).toBeGreaterThan(0);
    expect(matches).toEqual([]);
  });
});
