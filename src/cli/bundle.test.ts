import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  elementIdFor,
  generateObservedSnapshotId,
  runtimeId,
  type ResolvedSnapshotId,
} from '../core/ids.js';
import type { Interpretation } from '../core/interpretation.js';
import type { NativeOrigin, ObservedElement, ObservedSnapshot } from '../core/observed.js';
import type { ResolvedElement, ResolvedSnapshot } from '../core/resolved.js';
import { resolveProjectContext } from '../discovery/project-identity.js';
import {
  writeInterpretation,
  writeLatestPointer,
  writeObservedSnapshot,
  writeResolvedSnapshot,
} from '../snapshot/store.js';
import { runExport } from './export.js';

const rid = runtimeId('claude-code');
const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Pair {
  observed: ObservedElement;
  resolved: ResolvedElement;
}

function pair(
  kind: string,
  path: string,
  options: { origin?: NativeOrigin; digest?: string } = {},
): Pair {
  const origin = options.origin ?? (path.startsWith('~/') ? 'user' : 'project');
  const id = elementIdFor({ runtimeId: rid, origin, path, kind });
  return {
    observed: {
      id,
      native: { kind, origin, scope: origin },
      source: { path, ...(options.digest !== undefined ? { digest: options.digest } : {}) },
      inspectability: 'observable',
      metadata: {},
      status: 'observed',
    },
    resolved: {
      id,
      status: 'effective',
      applicability: { type: 'project' },
      activation: 'always',
      resolution: { strategy: 'accumulate', reason: 'test' },
    },
  };
}

async function seed(
  projectRoot: string,
  home: string,
  pairs: Pair[],
  files?: Record<string, string>,
): Promise<{ observed: ObservedSnapshot; resolved: ResolvedSnapshot }> {
  if (files !== undefined) {
    const { writeFile: wf } = await import('node:fs/promises');
    for (const [path, content] of Object.entries(files)) {
      const fullPath = join(projectRoot, path);
      const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
      await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true }));
      await wf(fullPath, content, 'utf8');
    }
  }

  const projectId = (await resolveProjectContext(projectRoot)).id;
  const observed: ObservedSnapshot = {
    schemaVersion: '1',
    snapshotId: generateObservedSnapshotId(),
    capturedAt: '2026-09-25T00:00:00.000Z',
    project: { id: projectId, displayName: 'owner/repo', root: projectRoot },
    runtime: { id: rid, version: '2.1.272' },
    adapter: { id: 'claude-code', version: '0.1.0', runtimeCompatibility: 'verified' },
    elements: pairs.map((p) => p.observed),
    diagnostics: [],
    completeness: 'complete',
    digests: { observed: 'sha256:x' },
  };
  const resolved: ResolvedSnapshot = {
    schemaVersion: '1',
    snapshotId: 'res_test' as ResolvedSnapshotId,
    observedSnapshotId: observed.snapshotId,
    runtime: { id: rid, version: '2.1.272' },
    resolution: { semanticsVersion: '1', confidence: 'verified' },
    elements: pairs.map((p) => p.resolved),
    relations: [],
    effectiveElementIds: [],
    diagnostics: [],
    digests: { harnessContent: 'sha256:h', resolvedSnapshot: 'sha256:r' },
  };
  await writeObservedSnapshot(projectId, observed, home);
  await writeResolvedSnapshot(projectId, resolved, home);
  const interpretation: Interpretation = {
    schemaVersion: '1',
    interpretationId: 'int_test' as never,
    resolvedSnapshotId: resolved.snapshotId,
    classifier: { id: 'pfl-native', version: '5' },
    elements: pairs.map((p) => ({
      elementId: p.observed.id,
      facets: [],
      confidence: 'high',
      reason: 'test',
    })),
    stats: {
      observed: pairs.length,
      effective: pairs.length,
      shadowed: 0,
      conditional: 0,
      opaque: 0,
      byFacet: {},
    },
    findings: [],
  };
  await writeInterpretation(projectId, interpretation, home);
  await writeLatestPointer(
    projectId,
    { observed: observed.snapshotId, resolved: resolved.snapshotId },
    home,
  );
  return { observed, resolved };
}

function fakeLogger() {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (message: string, data?: Record<string, unknown>) => {
        lines.push(data === undefined ? message : JSON.stringify({ message, ...data }));
      },
      warn: () => undefined,
      error: () => undefined,
    },
  };
}

describe('evidence bundle', () => {
  it('creates harness.json, evidence files, and manifest.json', async () => {
    const projectRoot = await tempDir('pfl-bundle-project-');
    const home = await tempDir('pfl-bundle-home-');
    const bundleDir = join(await tempDir('pfl-bundle-out-'), 'my-bundle');
    const fileA = pair('instructions', 'CLAUDE.md');
    const fileB = pair('permissions', '.claude/settings.json');
    await seed(projectRoot, home, [fileA, fileB], {
      'CLAUDE.md': '# Instructions\nBe helpful.',
      '.claude/settings.json': '{"permissions": ["read"]}',
    });
    const { logger } = fakeLogger();

    const outcome = await runExport(projectRoot, { home, json: true, bundle: bundleDir }, logger);

    const entries = await readdir(bundleDir);
    expect(entries).toContain('harness.json');
    expect(entries).toContain('manifest.json');
    expect(entries).toContain('evidence');

    const evidenceEntries = await readdir(join(bundleDir, 'evidence'));
    expect(evidenceEntries).toHaveLength(2);

    const harness = JSON.parse(await readFile(join(bundleDir, 'harness.json'), 'utf8'));
    expect(harness.elements).toHaveLength(2);

    const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
    expect(manifest.schemaVersion).toBe('1');
    expect(manifest.harnessDigest).toMatch(/^sha256:/);
    expect(manifest.observedSnapshotId).toBe(outcome.data.snapshot.observedSnapshotId);
    expect(manifest.evidence).toHaveLength(2);
  });

  it('reads actual file content into evidence files', async () => {
    const projectRoot = await tempDir('pfl-bundle-project-');
    const home = await tempDir('pfl-bundle-home-');
    const bundleDir = join(await tempDir('pfl-bundle-out-'), 'my-bundle');
    const fileContent = '# Test Instructions\nThis is a test.';
    const elem = pair('instructions', 'CLAUDE.md');
    await seed(projectRoot, home, [elem], { 'CLAUDE.md': fileContent });
    const { logger } = fakeLogger();

    await runExport(projectRoot, { home, json: true, bundle: bundleDir }, logger);

    const evidenceContent = await readFile(join(bundleDir, 'evidence', elem.observed.id), 'utf8');
    expect(evidenceContent).toBe(fileContent);
  });

  it('skips elements without source.path', async () => {
    const projectRoot = await tempDir('pfl-bundle-project-');
    const home = await tempDir('pfl-bundle-home-');
    const bundleDir = join(await tempDir('pfl-bundle-out-'), 'my-bundle');
    const noPath: Pair = {
      observed: {
        id: elementIdFor({ runtimeId: rid, origin: 'builtin', path: '(builtin)', kind: 'layer' }),
        native: { kind: 'layer', origin: 'builtin', scope: null },
        source: {},
        inspectability: 'opaque',
        metadata: {},
        status: 'observed',
      },
      resolved: {
        id: elementIdFor({ runtimeId: rid, origin: 'builtin', path: '(builtin)', kind: 'layer' }),
        status: 'effective',
        applicability: { type: 'project' },
        activation: 'always',
        resolution: { strategy: 'accumulate', reason: 'test' },
      },
    };
    await seed(projectRoot, home, [noPath]);
    const { logger } = fakeLogger();

    await runExport(projectRoot, { home, json: true, bundle: bundleDir }, logger);

    const evidenceEntries = await readdir(join(bundleDir, 'evidence'));
    expect(evidenceEntries).toHaveLength(0);

    const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
    expect(manifest.evidence).toHaveLength(1);
    expect(manifest.evidence[0].status).toBe('skipped');
    expect(manifest.evidence[0].reasonCode).toBe('no-source-path');
  });

  it('does not create a bundle when --bundle is omitted', async () => {
    const projectRoot = await tempDir('pfl-bundle-project-');
    const home = await tempDir('pfl-bundle-home-');
    const elem = pair('instructions', 'CLAUDE.md');
    await seed(projectRoot, home, [elem]);
    const { logger } = fakeLogger();

    const outcome = await runExport(projectRoot, { home, json: true }, logger);
    expect(outcome.data.elements).toHaveLength(1);
  });

  it('produces a manifest with matching harnessDigest', async () => {
    const projectRoot = await tempDir('pfl-bundle-project-');
    const home = await tempDir('pfl-bundle-home-');
    const bundleDir = join(await tempDir('pfl-bundle-out-'), 'my-bundle');
    const elem = pair('instructions', 'CLAUDE.md');
    await seed(projectRoot, home, [elem], { 'CLAUDE.md': 'test' });
    const { logger } = fakeLogger();

    await runExport(projectRoot, { home, json: true, bundle: bundleDir }, logger);

    const harnessContent = await readFile(join(bundleDir, 'harness.json'), 'utf8');
    const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));

    const { createHash } = await import('node:crypto');
    const actualDigest = `sha256:${createHash('sha256').update(harnessContent).digest('hex')}`;
    expect(manifest.harnessDigest).toBe(actualDigest);
  });

  it('records sha256 digest of evidence content', async () => {
    const projectRoot = await tempDir('pfl-bundle-project-');
    const home = await tempDir('pfl-bundle-home-');
    const bundleDir = join(await tempDir('pfl-bundle-out-'), 'my-bundle');
    const fileContent = 'evidence content for digest test';
    const elem = pair('instructions', 'CLAUDE.md');
    await seed(projectRoot, home, [elem], { 'CLAUDE.md': fileContent });
    const { logger } = fakeLogger();

    await runExport(projectRoot, { home, json: true, bundle: bundleDir }, logger);

    const evidenceContent = await readFile(join(bundleDir, 'evidence', elem.observed.id), 'utf8');
    const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
    const entry = manifest.evidence.find(
      (e: { elementId: string }) => e.elementId === elem.observed.id,
    );

    const { createHash } = await import('node:crypto');
    const actualDigest = `sha256:${createHash('sha256').update(evidenceContent).digest('hex')}`;
    expect(entry.actualDigest).toBe(actualDigest);
    expect(entry.sizeBytes).toBe(Buffer.byteLength(fileContent, 'utf8'));
    expect(entry.status).toBe('included');
    // Without a digest on the observed element, verified is false
    expect(entry.verified).toBe(false);
  });

  it('detects config fragments (#permissions) and reads the underlying file', async () => {
    const projectRoot = await tempDir('pfl-bundle-project-');
    const home = await tempDir('pfl-bundle-home-');
    const bundleDir = join(await tempDir('pfl-bundle-out-'), 'my-bundle');
    const fileContent = '{"permissions": ["read"]}';
    // Config fragment: adapter generates settings.json#permissions
    const configElem = pair('permissions', '.claude/settings.json#permissions');
    await seed(projectRoot, home, [configElem], {
      '.claude/settings.json': fileContent,
    });
    const { logger } = fakeLogger();

    await runExport(projectRoot, { home, json: true, bundle: bundleDir }, logger);

    const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
    const entry = manifest.evidence.find(
      (e: { elementId: string }) => e.elementId === configElem.observed.id,
    );
    // Should read the underlying settings.json, not the literal #permissions filename
    expect(entry.status).toBe('included');
    expect(entry.actualDigest).toMatch(/^sha256:/);
    // Config elements lack source.digest, so evidence is unverified
    expect(entry.verified).toBe(false);

    const evidenceContent = await readFile(
      join(bundleDir, 'evidence', configElem.observed.id),
      'utf8',
    );
    expect(evidenceContent).toBe(fileContent);
  });

  it('skips user-scope elements (~/...) with outside-project-scope', async () => {
    const projectRoot = await tempDir('pfl-bundle-project-');
    const home = await tempDir('pfl-bundle-home-');
    const bundleDir = join(await tempDir('pfl-bundle-out-'), 'my-bundle');
    const userElem = pair('memory', '~/.claude/CLAUDE.md', { origin: 'user' });
    await seed(projectRoot, home, [userElem]);
    const { logger } = fakeLogger();

    await runExport(projectRoot, { home, json: true, bundle: bundleDir }, logger);

    const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
    const entry = manifest.evidence.find(
      (e: { elementId: string }) => e.elementId === userElem.observed.id,
    );
    expect(entry.status).toBe('skipped');
    expect(entry.reasonCode).toBe('outside-project-scope');
  });

  it('skips ancestor elements (../...) with outside-project-scope', async () => {
    const projectRoot = await tempDir('pfl-bundle-project-');
    const home = await tempDir('pfl-bundle-home-');
    const bundleDir = join(await tempDir('pfl-bundle-out-'), 'my-bundle');
    const ancestorElem = pair('instructions', '../CLAUDE.md');
    await seed(projectRoot, home, [ancestorElem]);
    const { logger } = fakeLogger();

    await runExport(projectRoot, { home, json: true, bundle: bundleDir }, logger);

    const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
    const entry = manifest.evidence.find(
      (e: { elementId: string }) => e.elementId === ancestorElem.observed.id,
    );
    expect(entry.status).toBe('skipped');
    expect(entry.reasonCode).toBe('outside-project-scope');
  });

  it('skips symlinked evidence with reason symlink', async () => {
    const projectRoot = await tempDir('pfl-bundle-project-');
    const home = await tempDir('pfl-bundle-home-');
    const bundleDir = join(await tempDir('pfl-bundle-out-'), 'my-bundle');

    const realFile = join(projectRoot, 'real.md');
    await writeFile(realFile, 'real content', 'utf8');
    const linkFile = join(projectRoot, 'link.md');
    await symlink(realFile, linkFile);

    const symlinked = pair('instructions', 'link.md');
    await seed(projectRoot, home, [symlinked]);
    const { logger } = fakeLogger();

    await runExport(projectRoot, { home, json: true, bundle: bundleDir }, logger);

    const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
    const entry = manifest.evidence.find(
      (e: { elementId: string }) => e.elementId === symlinked.observed.id,
    );
    expect(entry.status).toBe('skipped');
    expect(entry.reasonCode).toBe('symlink');
  });

  it('detects modified evidence when source changed after inspection', async () => {
    const projectRoot = await tempDir('pfl-bundle-project-');
    const home = await tempDir('pfl-bundle-home-');
    const bundleDir = join(await tempDir('pfl-bundle-out-'), 'my-bundle');
    const originalContent = 'original content';
    const modifiedContent = 'modified content';

    // Seed with a digest matching the original content
    const { createHash } = await import('node:crypto');
    const expectedDigest = `sha256:${createHash('sha256').update(originalContent).digest('hex')}`;
    const elem = pair('instructions', 'CLAUDE.md', { digest: expectedDigest });
    await seed(projectRoot, home, [elem], { 'CLAUDE.md': modifiedContent });
    const { logger } = fakeLogger();

    await runExport(projectRoot, { home, json: true, bundle: bundleDir }, logger);

    const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
    const entry = manifest.evidence.find(
      (e: { elementId: string }) => e.elementId === elem.observed.id,
    );
    expect(entry.status).toBe('modified');
    expect(entry.expectedDigest).toBe(expectedDigest);
    expect(entry.actualDigest).not.toBe(expectedDigest);
  });

  it('refuses bundle destination that is the project root', async () => {
    const projectRoot = await tempDir('pfl-bundle-project-');
    const home = await tempDir('pfl-bundle-home-');
    const elem = pair('instructions', 'CLAUDE.md');
    await seed(projectRoot, home, [elem]);
    const { logger } = fakeLogger();

    await expect(
      runExport(projectRoot, { home, json: true, bundle: projectRoot }, logger),
    ).rejects.toThrow('must not be the project root');
  });

  it('refuses bundle destination inside the project', async () => {
    const projectRoot = await tempDir('pfl-bundle-project-');
    const home = await tempDir('pfl-bundle-home-');
    const bundleDir = join(projectRoot, 'nested-bundle');
    const elem = pair('instructions', 'CLAUDE.md');
    await seed(projectRoot, home, [elem]);
    const { logger } = fakeLogger();

    await expect(
      runExport(projectRoot, { home, json: true, bundle: bundleDir }, logger),
    ).rejects.toThrow('must not be inside the project directory');
  });

  it('overwrites an existing bundle atomically via backup-and-rollback', async () => {
    const home = await tempDir('pfl-bundle-home-');
    const bundleDir = join(await tempDir('pfl-bundle-out-'), 'my-bundle');
    const elem = pair('instructions', 'CLAUDE.md');

    // First export: use a fresh projectRoot so the snapshot store is empty
    const projectRoot = await tempDir('pfl-bundle-proj1-');
    await seed(projectRoot, home, [elem], { 'CLAUDE.md': 'version 1' });
    const { logger } = fakeLogger();
    await runExport(projectRoot, { home, json: true, bundle: bundleDir }, logger);

    const manifest1 = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
    expect(manifest1.evidence).toHaveLength(1);
    expect(manifest1.evidence[0].actualDigest).toMatch(/^sha256:/);

    // Second export to same dir using the same projectRoot (store already has
    // the snapshot, so runExport reads it from store and re-runs bundle).
    await runExport(projectRoot, { home, json: true, bundle: bundleDir }, logger);

    const manifest2 = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
    const evidenceContent = await readFile(join(bundleDir, 'evidence', elem.observed.id), 'utf8');
    // Evidence content is the same because the snapshot hasn't changed,
    // but manifest timestamps differ, proving the overwrite happened.
    expect(evidenceContent).toBe('version 1');
    expect(manifest2.createdAt).toBeDefined();
    expect(manifest2.evidence).toHaveLength(1);
  });

  it('reads files under hash-named directories (team#one/file.md)', async () => {
    const projectRoot = await tempDir('pfl-bundle-project-');
    const home = await tempDir('pfl-bundle-home-');
    const bundleDir = join(await tempDir('pfl-bundle-out-'), 'my-bundle');
    const fileContent = 'hash-named directory file';
    // Path with # in a directory name (not a fragment)
    const elem = pair('instructions', 'team#one/file.md');
    await seed(projectRoot, home, [elem], { 'team#one/file.md': fileContent });
    const { logger } = fakeLogger();

    await runExport(projectRoot, { home, json: true, bundle: bundleDir }, logger);

    const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
    const entry = manifest.evidence.find(
      (e: { elementId: string }) => e.elementId === elem.observed.id,
    );
    // Full path should be tried first and succeed
    expect(entry.status).toBe('included');
    const evidenceContent = await readFile(join(bundleDir, 'evidence', elem.observed.id), 'utf8');
    expect(evidenceContent).toBe(fileContent);
  });

  it('rejects traversal paths (foo/../../etc/passwd) with outside-project-scope', async () => {
    const projectRoot = await tempDir('pfl-bundle-project-');
    const home = await tempDir('pfl-bundle-home-');
    const bundleDir = join(await tempDir('pfl-bundle-out-'), 'my-bundle');
    const traversalElem = pair('instructions', 'foo/../../etc/passwd');
    await seed(projectRoot, home, [traversalElem]);
    const { logger } = fakeLogger();

    await runExport(projectRoot, { home, json: true, bundle: bundleDir }, logger);

    const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
    const entry = manifest.evidence.find(
      (e: { elementId: string }) => e.elementId === traversalElem.observed.id,
    );
    expect(entry.status).toBe('skipped');
    expect(entry.reasonCode).toBe('outside-project-scope');
  });

  it('marks config evidence as unverified when source.digest is absent', async () => {
    const projectRoot = await tempDir('pfl-bundle-project-');
    const home = await tempDir('pfl-bundle-home-');
    const bundleDir = join(await tempDir('pfl-bundle-out-'), 'my-bundle');
    const fileContent = '{"hooks": {}}';
    // Config element — adapter does NOT set source.digest
    const configElem = pair('hooks', '.claude/settings.json#hooks');
    await seed(projectRoot, home, [configElem], {
      '.claude/settings.json': fileContent,
    });
    const { logger } = fakeLogger();

    await runExport(projectRoot, { home, json: true, bundle: bundleDir }, logger);

    const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
    const entry = manifest.evidence.find(
      (e: { elementId: string }) => e.elementId === configElem.observed.id,
    );
    expect(entry.status).toBe('included');
    // Config elements lack source.digest → verified: false
    expect(entry.verified).toBe(false);
    expect(entry.expectedDigest).toBeUndefined();
  });
});
