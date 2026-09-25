import { randomBytes } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ElementId } from '../core/ids.js';
import { fragmentKeyOf } from '../core/element-path.js';
import { isPathWithin, readTextFileGuarded } from '../util/fs.js';
import { sha256Digest } from '../util/hash.js';
import type { ExportData, ExportElement } from './export.js';

const BUNDLE_EVIDENCE_DIR = 'evidence';
const BUNDLE_MANIFEST_FILE = 'manifest.json';
const BUNDLE_HARNESS_FILE = 'harness.json';
const BUNDLE_DIR_MODE = 0o700;
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024; // 10 MB per evidence file

export type EvidenceStatus = 'included' | 'missing' | 'modified' | 'skipped';

/**
 * A single evidence entry in the manifest, mapping an element to its bundled
 * source file and integrity digest. The `status` field distinguishes included
 * from skipped/missing/modified evidence, enabling a downstream consumer to
 * verify integrity and detect stale files.
 */
export interface ManifestEvidenceEntry {
  elementId: ElementId;
  /** The original display path (redacted form, as stored in the element). */
  sourcePath: string;
  /** Status of this evidence entry. */
  status: EvidenceStatus;
  /** SHA-256 digest from the observed snapshot (inspect time). */
  expectedDigest?: string;
  /** SHA-256 digest of the actual file content at export time. */
  actualDigest?: string;
  /** Bundle-relative path to the evidence file. */
  evidencePath?: string;
  /** File size in bytes. */
  sizeBytes?: number;
  /** Reason code when status is 'skipped'. */
  reasonCode?: string;
}

/**
 * The manifest structure written to the bundle directory root. It enables a
 * downstream consumer (an Analyzer) to verify the integrity of every bundled
 * evidence file and detect modified sources.
 */
export interface BundleManifest {
  schemaVersion: string;
  harnessDigest: string;
  observedSnapshotId: string;
  resolvedSnapshotId: string;
  createdAt: string;
  evidence: ManifestEvidenceEntry[];
}

export interface BundleOptions {
  projectRoot: string;
  bundleDir: string;
}

/**
 * Writes a full evidence bundle: harness.json, evidence files, and
 * manifest.json into `bundleDir`.
 *
 * INV-001: only runs when `--bundle` is provided; default `pfl export` is
 * unchanged.
 * INV-002: uses `readTextFileGuarded` to avoid symlinks/hardlinks.
 * INV-003: `readTextFileGuarded` enforces project-root containment via baseDir.
 * INV-005: writes to a randomBytes staging dir, backup-and-rollback replaces
 *          atomically, cleans up on failure.
 * INV-006: clears stale evidence by replacing the entire bundle dir.
 */
export async function writeBundle(
  data: ExportData,
  elements: ExportElement[],
  options: BundleOptions,
): Promise<void> {
  const { projectRoot, bundleDir } = options;
  await assertValidBundleDir(bundleDir, projectRoot);

  // INV-005: staging dir with random suffix for atomicity and unique naming.
  const stagingDir = `${bundleDir}.staging.${randomBytes(6).toString('hex')}`;
  const stagingEvidenceDir = join(stagingDir, BUNDLE_EVIDENCE_DIR);
  let backupDir: string | undefined;

  try {
    await mkdir(stagingEvidenceDir, { recursive: true, mode: BUNDLE_DIR_MODE });

    const evidence: ManifestEvidenceEntry[] = [];
    for (const element of elements) {
      const result = await collectEvidence(element, projectRoot, stagingEvidenceDir);
      evidence.push(result);
    }

    const harnessContent = JSON.stringify(data, null, 2);
    const harnessDigest = sha256Digest(harnessContent);

    const manifest: BundleManifest = {
      schemaVersion: '1',
      harnessDigest,
      observedSnapshotId: data.snapshot.observedSnapshotId,
      resolvedSnapshotId: data.snapshot.resolvedSnapshotId,
      createdAt: new Date().toISOString(),
      evidence,
    };

    await writeFile(join(stagingDir, BUNDLE_HARNESS_FILE), harnessContent, { mode: 0o600 });
    await writeFile(join(stagingDir, BUNDLE_MANIFEST_FILE), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });

    // Backup-and-rollback: if the destination exists, move it aside first,
    // then rename staging into place, and clean up the backup on success.
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
    // Clean up staging dir on any failure.
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    // Restore backup if rename failed after backup was created.
    if (backupDir !== undefined) {
      await rename(backupDir, bundleDir).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Collects evidence for a single element. Reads the source file via
 * `readTextFileGuarded` (INV-002, INV-003), computes the digest, and compares
 * it against the snapshot's expected digest (BUG_0004).
 */
async function collectEvidence(
  element: ExportElement,
  projectRoot: string,
  evidenceDir: string,
): Promise<ManifestEvidenceEntry> {
  const sourcePath = element.observed.source.path;

  if (sourcePath === undefined) {
    return {
      elementId: element.id,
      sourcePath: '(none)',
      status: 'skipped',
      reasonCode: 'no-source-path',
    };
  }

  // INV-003: detect non-project paths before any resolution.
  if (!isProjectLocal(sourcePath, projectRoot)) {
    return {
      elementId: element.id,
      sourcePath,
      status: 'skipped',
      reasonCode: 'outside-project-scope',
    };
  }

  // BUG_0002: strip synthetic #fragment for filesystem resolution.
  const physicalPath = stripFragment(sourcePath);
  const resolvedSource = resolve(projectRoot, physicalPath);

  const read = await readTextFileGuarded(resolvedSource, MAX_EVIDENCE_BYTES, projectRoot);
  if (read.status !== 'ok') {
    return {
      elementId: element.id,
      sourcePath,
      status: 'skipped',
      reasonCode: read.status,
    };
  }

  const content = read.text;
  const actualDigest = sha256Digest(content);
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  const evidencePath = join(BUNDLE_EVIDENCE_DIR, element.id);

  // BUG_0004: compare against snapshot's expected digest.
  const expectedDigest = element.observed.source.digest;
  const status: EvidenceStatus =
    expectedDigest !== undefined && actualDigest !== expectedDigest ? 'modified' : 'included';

  await writeFile(join(evidenceDir, element.id), content, { mode: 0o600 });

  const entry: ManifestEvidenceEntry = {
    elementId: element.id,
    sourcePath,
    status,
    actualDigest,
    evidencePath,
    sizeBytes,
  };
  if (expectedDigest !== undefined) entry.expectedDigest = expectedDigest;
  return entry;
}

/**
 * Whether a display path is project-local and can be resolved within
 * projectRoot. Non-project paths (~/..., ../..., absolute outside project)
 * are out of scope for this PR; they require adapter-level resolution with
 * consent gating (follow-up architecture change).
 */
function isProjectLocal(sourcePath: string, projectRoot: string): boolean {
  // Absolute path: check if it's within the project root.
  if (isAbsolute(sourcePath)) {
    // Use a synchronous check: the real project root resolves to itself.
    const rel = relative(projectRoot, sourcePath);
    return rel !== '' && !rel.startsWith('..');
  }
  // Tilde-prefixed paths are user-scope (~/...).
  if (sourcePath.startsWith('~/')) return false;
  // Relative paths starting with ../ are ancestor-scope.
  if (sourcePath.startsWith('../')) return false;
  return true;
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

  // Refuse to write into an existing regular file.
  const entry = await lstat(resolved).catch(() => null);
  if (entry !== null && !entry.isDirectory() && !entry.isSymbolicLink()) {
    throw new Error('bundle destination exists but is not a directory');
  }
}

async function pathExists(path: string): Promise<boolean> {
  const entry = await lstat(path).catch(() => null);
  return entry !== null;
}
