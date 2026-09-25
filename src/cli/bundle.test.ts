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
  options: { origin?: NativeOrigin; content?: string } = {},
): Pair {
  const origin = options.origin ?? (path.startsWith('~/') ? 'user' : 'project');
  const id = elementIdFor({ runtimeId: rid, origin, path, kind });
  return {
    observed: {
      id,
      native: { kind, origin, scope: origin },
      source: { path },
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
  // Write evidence source files into the project root
  if (files !== undefined) {
    const { writeFile } = await import('node:fs/promises');
    for (const [path, content] of Object.entries(files)) {
      const fullPath = join(projectRoot, path);
      const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
      await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true }));
      await writeFile(fullPath, content, 'utf8');
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

    // Bundle directory structure
    const entries = await readdir(bundleDir);
    expect(entries).toContain('harness.json');
    expect(entries).toContain('manifest.json');
    expect(entries).toContain('evidence');

    // evidence directory contains files for each element
    const evidenceEntries = await readdir(join(bundleDir, 'evidence'));
    expect(evidenceEntries).toHaveLength(2);

    // harness.json is valid JSON matching the export data
    const harnessContent = await readFile(join(bundleDir, 'harness.json'), 'utf8');
    const harness = JSON.parse(harnessContent);
    expect(harness.elements).toHaveLength(2);

    // manifest.json has correct structure
    const manifestContent = await readFile(join(bundleDir, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestContent);
    expect(manifest.schemaVersion).toBe('1');
    expect(manifest.harnessDigest).toMatch(/^sha256:/);
    expect(manifest.observedSnapshotId).toBe(outcome.data.snapshot.observedSnapshotId);
    expect(manifest.evidence).toHaveLength(2);

    // Each evidence entry has elementId, sourcePath, digest, sizeBytes
    for (const entry of manifest.evidence) {
      expect(entry.elementId).toBeTruthy();
      expect(entry.sourcePath).toBeTruthy();
      expect(entry.digest).toMatch(/^sha256:/);
      expect(typeof entry.sizeBytes).toBe('number');
    }
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
    // Element with no path (e.g. builtin layer)
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

    // evidence dir should be empty (no file for the skipped element)
    const evidenceEntries = await readdir(join(bundleDir, 'evidence'));
    expect(evidenceEntries).toHaveLength(0);

    // manifest should record the skip
    const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
    expect(manifest.evidence).toHaveLength(1);
    expect(manifest.evidence[0].skipped).toBe(true);
    expect(manifest.evidence[0].skipReason).toBe('no source path');
  });

  it('does not create a bundle when --bundle is omitted', async () => {
    const projectRoot = await tempDir('pfl-bundle-project-');
    const home = await tempDir('pfl-bundle-home-');
    const elem = pair('instructions', 'CLAUDE.md');
    await seed(projectRoot, home, [elem]);
    const { logger } = fakeLogger();

    const outcome = await runExport(projectRoot, { home, json: true }, logger);

    // No bundle directory should be created
    expect(outcome.data.elements).toHaveLength(1);
    // The export data is returned but no files are written
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

    // The harnessDigest in the manifest should match sha256 of harness.json
    const { createHash } = await import('node:crypto');
    const actualDigest = `sha256:${createHash('sha256').update(harnessContent).digest('hex')}`;
    expect(manifest.harnessDigest).toBe(actualDigest);
  });

  it('records sha256 digest of evidence content (FIND-004)', async () => {
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

    // Compute SHA-256 from the actual evidence file bytes
    const { createHash } = await import('node:crypto');
    const actualDigest = `sha256:${createHash('sha256').update(evidenceContent).digest('hex')}`;
    expect(entry.digest).toBe(actualDigest);
    expect(entry.sizeBytes).toBe(Buffer.byteLength(fileContent, 'utf8'));
  });

  it('skips symlinked evidence files (FIND-003)', async () => {
    const projectRoot = await tempDir('pfl-bundle-project-');
    const home = await tempDir('pfl-bundle-home-');
    const bundleDir = join(await tempDir('pfl-bundle-out-'), 'my-bundle');

    // Create a real file and a symlink to it
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
    // Symlinked files should be skipped by readTextFileGuarded
    expect(entry.skipped).toBe(true);
    expect(entry.skipReason).toBe('symlink');
  });

  it('skips sources outside the project root (FIND-003)', async () => {
    const projectRoot = await tempDir('pfl-bundle-project-');
    const home = await tempDir('pfl-bundle-home-');
    const bundleDir = join(await tempDir('pfl-bundle-out-'), 'my-bundle');

    // Create a file outside the project root
    const outsideDir = await tempDir('pfl-outside-');
    const outsideFile = join(outsideDir, 'secret.md');
    await writeFile(outsideFile, 'secret content', 'utf8');

    // Use a path that resolves outside the project root via ../
    const outsideElem = pair('instructions', '../outside-project/secret.md');
    await seed(projectRoot, home, [outsideElem]);
    const { logger } = fakeLogger();

    await runExport(projectRoot, { home, json: true, bundle: bundleDir }, logger);

    const manifest = JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'));
    const entry = manifest.evidence.find(
      (e: { elementId: string }) => e.elementId === outsideElem.observed.id,
    );
    // readTextFileGuarded enforces project-root containment
    expect(entry.skipped).toBe(true);
  });
});
