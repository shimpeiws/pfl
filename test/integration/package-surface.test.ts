import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The package surface is the CLI and the on-disk schema only (design doc §1,
 * `pfl-roadmap-v1.0.md` §1). An absent `exports` field left every `dist/` path
 * deep-importable, so `exports` is declared restrictively and this test asserts
 * the surface cannot quietly reopen. Node's own resolver is used — not the test
 * runner's — so the manifest is what is under test, not a bundler's leniency.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(repoRoot, 'package.json'));

function resolutionError(specifier: string): { code?: string } | undefined {
  try {
    require.resolve(specifier);
    return undefined;
  } catch (error) {
    return error as { code?: string };
  }
}

describe('package surface', () => {
  it('blocks deep imports and the bare package entry', () => {
    expect(resolutionError('@shimpeiws/pfl')?.code).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
    expect(resolutionError('@shimpeiws/pfl/dist/snapshot/store.js')?.code).toBe(
      'ERR_PACKAGE_PATH_NOT_EXPORTED',
    );
  });

  it('keeps the manifest introspectable and the bin entry outside the export map', () => {
    expect(require.resolve('@shimpeiws/pfl/package.json')).toContain('package.json');
    const manifest = require('@shimpeiws/pfl/package.json') as {
      bin: Record<string, string>;
      exports: Record<string, string>;
    };
    // The bin is executed by path, so `exports` must not (and does not) list it.
    expect(manifest.bin['pfl']).toBe('dist/index.js');
    expect(Object.keys(manifest.exports)).toEqual(['./package.json']);
  });
});
