import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { ElementId } from '../core/ids.js';
import { fragmentKeyOf } from '../core/element-path.js';
import { inspectFileTarget, isPathWithin } from '../util/fs.js';
import { sha256Digest } from '../util/hash.js';
import type { ExportData, ExportElement } from './export.js';

const BUNDLE_MANIFEST_FILE = 'manifest.json';
const BUNDLE_HARNESS_FILE = 'harness.json';
const BUNDLE_DIR_MODE = 0o700;
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024; // 10 MB per evidence file

export type EvidenceStatus = 'included' | 'missing' | 'modified' | 'skipped';

/**
 * R3: Evidence entry in the manifest — metadata only, no raw content.
 * Records digest, status, and verification state for downstream analysis.
 */
export interface ManifestEvidenceEntry {
  elementId: ElementId;
  sourcePath: string;
  status: EvidenceStatus;
  verified: boolean;
  expectedDigest?: string;
  actualDigest?: string;
  sizeBytes?: number;
  reasonCode?: string;
}

/**
 * R3: Manifest — sanitized harness.json and evidence metadata only.
 * containsRawEvidence is always false (§19 deny-by-default).
 */
export interface BundleManifest {
  schemaVersion: string;
  harnessDigest: string;
  observedSnapshotId: string;
  resolvedSnapshotId: string;
  createdAt: string;
  containsRawEvidence: false;
  evidence: ManifestEvidenceEntry[];
}

export interface BundleOptions {
  projectRoot: string;
  bundleDir: string;
}

/**
 * R3: Writes a bundle with sanitized harness.json and evidence metadata.
 * No raw file content is written (§19 deny-by-default).
 */
export async function writeBundle(
  data: ExportData,
  elements: ExportElement[],
  options: BundleOptions,
): Promise<void> {
  const { projectRoot, bundleDir } = options;
  await assertValidBundleDir(bundleDir, projectRoot);

  const stagingDir = `${bundleDir}.staging.${randomBytes(6).toString('hex')}`;
  let backupDir: string | undefined;

  try {
    await mkdir(stagingDir, { recursive: true, mode: BUNDLE_DIR_MODE });

    const evidence: ManifestEvidenceEntry[] = [];
    for (const element of elements) {
      evidence.push(await collectEvidenceMetadata(element, projectRoot));
    }

    const harnessContent = JSON.stringify(data, null, 2);
    const harnessDigest = sha256Digest(harnessContent);

    const manifest: BundleManifest = {
      schemaVersion: '1',
      harnessDigest,
      observedSnapshotId: data.snapshot.observedSnapshotId,
      resolvedSnapshotId: data.snapshot.resolvedSnapshotId,
      createdAt: new Date().toISOString(),
      containsRawEvidence: false,
      evidence,
    };

    await writeFile(join(stagingDir, BUNDLE_HARNESS_FILE), harnessContent, { mode: 0o600 });
    await writeFile(join(stagingDir, BUNDLE_MANIFEST_FILE), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });

    const destExists = await pathExists(bundleDir);
    if (destExists) {
      backupDir = `${bundleDir}.backup.${randomBytes(6).toString('hex')}`;
      await rename(bundleDir, backupDir);
    }
    await rename(stagingDir, bundleDir);
    if (backupDir !== undefined) {
      await rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    if (backupDir !== undefined) {
      await rename(backupDir, bundleDir).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * R3: Collects evidence metadata. Reads the source file to compute the
 * digest and detect missing/modified, but does NOT write content to bundle.
 *
 * BUG_0001: always strips synthetic #fragment (always-strip). Literal # in
 * file paths results in missing status rather than bundling wrong content.
 */
async function collectEvidenceMetadata(
  element: ExportElement,
  projectRoot: string,
): Promise<ManifestEvidenceEntry> {
  const sourcePath = element.observed.source.path;

  if (sourcePath === undefined) {
    return {
      elementId: element.id,
      sourcePath: '(none)',
      status: 'skipped',
      verified: false,
      reasonCode: 'no-source-path',
    };
  }

  if (!isProjectLocal(sourcePath, projectRoot)) {
    return {
      elementId: element.id,
      sourcePath,
      status: 'skipped',
      verified: false,
      reasonCode: 'outside-project-scope',
    };
  }

  // BUG_0001: always strip synthetic #fragment. Literal # in file paths
  // results in missing status — safer than bundling wrong content.
  const physicalPath = stripFragment(sourcePath);
  const resolvedSource = resolve(projectRoot, physicalPath);

  // D2: Use inspectFileTarget for symlink/hardlink/regular checks, then
  // readFile as Buffer for raw-byte digest (matches discovery's digest).
  const target = await inspectFileTarget(resolvedSource, projectRoot);
  if (target.status === 'missing') {
    return { elementId: element.id, sourcePath, status: 'missing', verified: false };
  }
  if (target.status !== 'ok') {
    return {
      elementId: element.id,
      sourcePath,
      status: 'skipped',
      verified: false,
      reasonCode: target.status,
    };
  }
  if ((target.sizeBytes ?? 0) > MAX_EVIDENCE_BYTES) {
    return {
      elementId: element.id,
      sourcePath,
      status: 'skipped',
      verified: false,
      reasonCode: 'too-large',
    };
  }

  // D2: Read as Buffer for raw-byte digest (UTF-8 replacement chars would
  // differ from discovery's raw-byte hash for non-UTF-8 files).
  let content: Buffer;
  try {
    content = await readFile(resolvedSource);
  } catch {
    return {
      elementId: element.id,
      sourcePath,
      status: 'skipped',
      verified: false,
      reasonCode: 'unreadable',
    };
  }

  const actualDigest = sha256Digest(content);
  const sizeBytes = content.length;
  const expectedDigest = element.observed.source.digest;
  // D1: verified requires both presence AND match of expected digest.
  const digestMatches = expectedDigest !== undefined && actualDigest === expectedDigest;
  const status: EvidenceStatus =
    expectedDigest !== undefined && !digestMatches ? 'modified' : 'included';
  const verified = digestMatches;

  // D6: An element not observed at inspection time should not become
  // 'included' at export time, even if the file is readable now.
  if (element.observed.status !== 'observed') {
    return {
      elementId: element.id,
      sourcePath,
      status: 'skipped',
      verified: false,
      reasonCode: `not-observed-at-inspection:${element.observed.status}`,
    };
  }

  const entry: ManifestEvidenceEntry = {
    elementId: element.id,
    sourcePath,
    status,
    verified,
    actualDigest,
    sizeBytes,
  };
  if (expectedDigest !== undefined) entry.expectedDigest = expectedDigest;
  return entry;
}

/**
 * BUG_0002: Canonical containment check using resolve + relative.
 * Catches internal traversal (foo/../../etc/passwd) and dot-prefixed
 * dirs (..draft) that the previous prefix-based check missed.
 */
function isProjectLocal(sourcePath: string, projectRoot: string): boolean {
  if (sourcePath.startsWith('~/')) return false;
  const resolved = resolve(projectRoot, sourcePath);
  const rel = relative(projectRoot, resolved);
  // rel === '..' means the path resolved to the project root's parent.
  // rel.startsWith('../') means it escaped above the project root.
  // rel.startsWith('..') without '/' is NOT a parent reference (e.g. '..draft').
  return rel !== '' && rel !== '..' && !rel.startsWith('../');
}

/** Strips the synthetic #fragment suffix from a display path. */
function stripFragment(sourcePath: string): string {
  return fragmentKeyOf(sourcePath) !== null
    ? sourcePath.slice(0, sourcePath.indexOf('#'))
    : sourcePath;
}

/** Checks that bundleDir is safe: not project root, not inside project, not a file. */
async function assertValidBundleDir(bundleDir: string, projectRoot: string): Promise<void> {
  const resolved = resolve(bundleDir);

  if (resolved === projectRoot) {
    throw new Error('bundle destination must not be the project root');
  }

  if (await isPathWithin(projectRoot, resolved)) {
    throw new Error('bundle destination must not be inside the project directory');
  }

  const entry = await lstat(resolved).catch(() => null);
  if (entry !== null && !entry.isDirectory()) {
    throw new Error('bundle destination exists but is not a directory');
  }
}

async function pathExists(path: string): Promise<boolean> {
  const entry = await lstat(path).catch(() => null);
  return entry !== null;
}
