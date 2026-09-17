import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '../core/diagnostics.js';
import { packageVersion } from '../version.js';
import { buildDocument, buildErrorDocument, EXIT_CODE_NAMES } from './document.js';
import { EXIT_CODES, PflError } from './exit-codes.js';

const ctx = { home: '/Users/alice' };

describe('document envelope', () => {
  it('maps exit codes to their stable names', () => {
    expect(EXIT_CODE_NAMES[EXIT_CODES.CONFIG_ERROR]).toBe('CONFIG_ERROR');
    expect(EXIT_CODE_NAMES[EXIT_CODES.RUNTIME_UNSUPPORTED]).toBe('RUNTIME_UNSUPPORTED');
    expect(EXIT_CODE_NAMES[EXIT_CODES.INSPECTION_FAILED]).toBe('INSPECTION_FAILED');
    expect(EXIT_CODE_NAMES[EXIT_CODES.CONSENT_REQUIRED]).toBe('CONSENT_REQUIRED');
    expect(EXIT_CODE_NAMES[EXIT_CODES.SNAPSHOT_STORE_FAILED]).toBe('SNAPSHOT_STORE_FAILED');
  });

  it('wraps a successful outcome in the common envelope', () => {
    const document = buildDocument(
      'report',
      { data: { effective: 2 }, diagnostics: [], completeness: 'partial' },
      ctx,
    );

    expect(document).toEqual({
      pflVersion: packageVersion,
      command: 'report',
      ok: true,
      completeness: 'partial',
      diagnostics: [],
      data: { effective: 2 },
    });
  });

  it('redacts diagnostics at the export level', () => {
    const diagnostic: Diagnostic = {
      severity: 'warning',
      code: 'unreadable-snapshot',
      message: 'could not read /Users/alice/.pfl/x.json',
      path: '/Users/alice/.pfl/x.json',
    };

    const document = buildDocument(
      'snapshots',
      { data: {}, diagnostics: [diagnostic], completeness: 'unknown' },
      ctx,
    );

    expect(document.diagnostics[0]?.message).not.toContain('/Users/alice');
    expect(document.diagnostics[0]?.path).not.toContain('/Users/alice');
    expect(document.diagnostics[0]?.path).toContain('~');
    // Codes are stable and pass through untouched.
    expect(document.diagnostics[0]?.code).toBe('unreadable-snapshot');
  });

  it('builds a failure envelope with the stable code name, not the number', () => {
    const document = buildErrorDocument(
      'inspect',
      new PflError('unknown runtime: bogus', EXIT_CODES.RUNTIME_UNSUPPORTED),
      ctx,
    );

    expect(document).toMatchObject({
      pflVersion: packageVersion,
      command: 'inspect',
      ok: false,
      completeness: 'unknown',
      data: { error: { code: 'RUNTIME_UNSUPPORTED', message: 'unknown runtime: bogus' } },
    });
  });

  it('carries structured error context such as missing consent scopes', () => {
    const document = buildErrorDocument(
      'inspect',
      new PflError('consent required', EXIT_CODES.CONSENT_REQUIRED, {
        missingScopes: ['claude-code:user'],
      }),
      ctx,
    );

    expect(document.ok).toBe(false);
    expect(document.data).toEqual({
      error: { code: 'CONSENT_REQUIRED', message: 'consent required' },
      missingScopes: ['claude-code:user'],
    });
  });

  it('adds no context field an error did not explicitly declare', () => {
    const document = buildErrorDocument(
      'report',
      new PflError('boom', EXIT_CODES.CONFIG_ERROR),
      ctx,
    );

    expect(document.data).toEqual({ error: { code: 'CONFIG_ERROR', message: 'boom' } });
  });

  it('maps an unexpected error to INSPECTION_FAILED and redacts the message', () => {
    const document = buildErrorDocument('report', new Error('boom /Users/alice/x'), ctx);

    expect(document.data).toEqual({
      error: { code: 'INSPECTION_FAILED', message: 'boom ~/x' },
    });
  });
});
