import { describe, expect, it } from 'vitest';
import { reconcileVersionSources } from './version-sources.js';

describe('reconcileVersionSources', () => {
  it('returns the highest version and no diagnostic when sources agree', () => {
    const result = reconcileVersionSources([
      { label: 'installer update metadata', version: '2.1.100' },
      { label: 'installer versions directory', version: '2.1.100' },
    ]);

    expect(result.version).toBe('2.1.100');
    expect(result.diagnostic).toBeNull();
  });

  it('names every disagreeing source and picks the highest', () => {
    const result = reconcileVersionSources([
      { label: 'installer releases directory', version: '0.139.0' },
      { label: 'npm global package', version: '0.154.0' },
    ]);

    expect(result.version).toBe('0.154.0');
    expect(result.diagnostic).toMatchObject({
      severity: 'warning',
      code: 'runtime-version-disagreement',
    });
    expect(result.diagnostic?.message).toContain('installer releases directory');
    expect(result.diagnostic?.message).toContain('npm global package');
    expect(result.diagnostic?.message).toContain('0.139.0');
    expect(result.diagnostic?.message).toContain('0.154.0');
  });

  it('ignores a source that does not parse rather than calling it a disagreement', () => {
    const result = reconcileVersionSources([
      { label: 'installer update metadata', version: 'not-a-version' },
      { label: 'installer versions directory', version: '2.1.100' },
    ]);

    expect(result.version).toBe('2.1.100');
    expect(result.diagnostic).toBeNull();
  });

  it('reports no version and no diagnostic when nothing parses', () => {
    const result = reconcileVersionSources([{ label: 'installer update metadata', version: 'x' }]);

    expect(result.version).toBeNull();
    expect(result.diagnostic).toBeNull();
  });
});
