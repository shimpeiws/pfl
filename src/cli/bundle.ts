import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { ElementId } from '../core/ids.js';
import { readTextFileGuarded } from '../util/fs.js';
import { sha256Digest } from '../util/hash.js';
import type { ExportData, ExportElement } from './export.js';

const BUNDLE_EVIDENCE_DIR = 'evidence';
const BUNDLE_MANIFEST_FILE = 'manifest.json';
const BUNDLE_HARNESS_FILE = 'harness.json';
const BUNDLE_DIR_MODE = 0o700;
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024; // 10 MB per evidence file

/**
 * A single evidence entry in the manifest, mapping an element to its bundled
 * source file and integrity digest.
 */
export interface ManifestEvidenceEntry {
  elementId: ElementId;
  /** The original source path (redacted form, as stored in the element). */
  sourcePath: string;
  /** SHA-256 digest of the evidence file content. */
  digest: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** Whether this element was skipped (no source.path or unreadable). */
  skipped?: boolean;
  /** Reason for skipping, when skipped is true. */
  skipReason?: string;
}

/**
 * The manifest structure written to the bundle directory root. It enables a
 * downstream consumer (an Analyzer) to verify the integrity of every bundled
 * evidence file without reading the full harness IR.
 */
export interface BundleManifest {
  /** Schema version of the manifest format. */
  schemaVersion: string;
  /** SHA-256 digest of the harness.json content (harness content digest). */
  harnessDigest: string;
  /** The observed snapshot id this bundle was exported from. */
  observedSnapshotId: string;
  /** The resolved snapshot id this bundle was exported from. */
  resolvedSnapshotId: string;
  /** ISO-8601 timestamp of when the bundle was created. */
  createdAt: string;
  /** Evidence entries for every element in the export. */
  evidence: ManifestEvidenceEntry[];
}

export interface BundleOptions {
  /** Absolute path to the project root (for resolving source paths). */
  projectRoot: string;
  /** Absolute path to the bundle output directory. */
  bundleDir: string;
}

/**
 * Writes a full evidence bundle: harness.json, evidence files, and
 * manifest.json into `bundleDir`.
 *
 * `export` is a projection that performs no new analysis; `--bundle` captures
 * the evidence it references, enabling offline analysis on another machine.
 *
 * INV-001: only runs when `--bundle` is provided; default `pfl export` is
 * unchanged.
 * INV-002: uses `readTextFileGuarded` to avoid symlinks/hardlinks.
 * INV-003: `readTextFileGuarded` enforces project-root containment via baseDir.
 * INV-005: writes to a temp directory and renames for atomicity; cleans up
 *          on failure so no partial bundle remains.
 * INV-006: clears stale evidence before writing so the manifest and directory
 *          contents are always consistent.
 */
export async function writeBundle(
  data: ExportData,
  elements: ExportElement[],
  options: BundleOptions,
): Promise<void> {
  const { projectRoot, bundleDir } = options;

  // INV-005: Write to a temp directory inside bundleDir, then rename.
  // This ensures no partial bundle is left on failure.
  const tempDir = `${bundleDir}.tmp.${Date.now()}`;
  const tempEvidenceDir = join(tempDir, BUNDLE_EVIDENCE_DIR);

  try {
    await mkdir(tempEvidenceDir, { recursive: true, mode: BUNDLE_DIR_MODE });

    const evidence: ManifestEvidenceEntry[] = [];
    for (const element of elements) {
      const result = await collectEvidence(element, projectRoot, tempEvidenceDir);
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

    await writeFile(join(tempDir, BUNDLE_HARNESS_FILE), harnessContent, { mode: 0o600 });
    await writeFile(join(tempDir, BUNDLE_MANIFEST_FILE), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });

    // INV-006: Remove the old bundle dir (if any) before renaming, so stale
    // evidence from a previous export is not left behind.
    await rm(bundleDir, { recursive: true, force: true });
    // Rename temp dir to the final bundle dir.
    await rename(tempDir, bundleDir);
  } catch (error) {
    // INV-005: Clean up the temp dir on any failure.
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Collects evidence for a single element. Reads the source file via
 * `readTextFileGuarded` (INV-002, INV-003), computes the digest, and writes
 * the content to `evidence/<elementId>`.
 */
async function collectEvidence(
  element: ExportElement,
  projectRoot: string,
  evidenceDir: string,
): Promise<ManifestEvidenceEntry> {
  const sourcePath = element.observed.source.path;

  if (sourcePath === undefined) {
    // INV-008: element without a source path is skipped, not errored.
    return {
      elementId: element.id,
      sourcePath: '(none)',
      digest: '',
      sizeBytes: 0,
      skipped: true,
      skipReason: 'no source path',
    };
  }

  // Resolve the source path. Paths may be absolute (e.g. ~/.claude/CLAUDE.md)
  // or project-relative. We need to resolve ~ and make it absolute for the
  // read guard.
  const resolvedSource = resolveSourcePath(sourcePath, projectRoot);

  const read = await readTextFileGuarded(resolvedSource, MAX_EVIDENCE_BYTES, projectRoot);
  if (read.status !== 'ok') {
    // INV-002: unreadable/symlink/hardlink/not-regular/missing → skip with reason.
    return {
      elementId: element.id,
      sourcePath,
      digest: '',
      sizeBytes: 0,
      skipped: true,
      skipReason: read.status,
    };
  }

  const content = read.text;
  const digest = sha256Digest(content);
  const sizeBytes = Buffer.byteLength(content, 'utf8');

  await writeFile(join(evidenceDir, element.id), content, { mode: 0o600 });

  return {
    elementId: element.id,
    sourcePath,
    digest,
    sizeBytes,
  };
}

/**
 * Resolves a source path (which may use ~ for home, or be project-relative)
 * to an absolute path suitable for `readTextFileGuarded`.
 */
function resolveSourcePath(sourcePath: string, projectRoot: string): string {
  // If the path is already absolute and exists, use it directly.
  if (isAbsolute(sourcePath)) return sourcePath;

  // Project-relative path: resolve against project root.
  const resolved = resolve(projectRoot, sourcePath);
  return resolved;
}
