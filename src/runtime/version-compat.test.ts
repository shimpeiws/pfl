import { describe, expect, it } from 'vitest';
import { compareVersions, highestVersion, isWithinRange, parseVersion } from './version-compat.js';

describe('parseVersion', () => {
  it('parses a leading semver and tolerates suffixes', () => {
    expect(parseVersion('2.1.272')).toEqual({ major: 2, minor: 1, patch: 272 });
    expect(parseVersion('0.154.0-aarch64-apple-darwin')).toEqual({
      major: 0,
      minor: 154,
      patch: 0,
    });
  });

  it('returns null when there is no version', () => {
    expect(parseVersion('not-a-version')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    const order = ['0.150.0', '0.154.0', '1.0.0', '2.1.0', '2.1.272'];
    for (let i = 1; i < order.length; i += 1) {
      const previous = parseVersion(order[i - 1] ?? '');
      const current = parseVersion(order[i] ?? '');
      expect(previous).not.toBeNull();
      expect(current).not.toBeNull();
      if (previous && current) expect(compareVersions(previous, current)).toBeLessThan(0);
    }
  });
});

describe('highestVersion', () => {
  it('returns the highest parseable version, normalized', () => {
    expect(highestVersion(['2.1.269', '2.1.272', '2.1.268'])).toBe('2.1.272');
    expect(highestVersion(['0.154.0-aarch64-apple-darwin', '0.150.0-x', 'garbage'])).toBe(
      '0.154.0',
    );
  });

  it('returns null when nothing parses', () => {
    expect(highestVersion(['garbage'])).toBeNull();
    expect(highestVersion([])).toBeNull();
  });
});

describe('isWithinRange', () => {
  const range = { min: '2.1.0', max: '2.2.0' };

  it('is inclusive of the minimum and exclusive of the maximum', () => {
    expect(isWithinRange('2.1.0', range)).toBe(true);
    expect(isWithinRange('2.1.272', range)).toBe(true);
    expect(isWithinRange('2.2.0', range)).toBe(false);
    expect(isWithinRange('2.0.9', range)).toBe(false);
  });

  it('treats an undeterminable version as unverified', () => {
    expect(isWithinRange(null, range)).toBe(false);
    expect(isWithinRange('unknown', range)).toBe(false);
  });
});
