import { describe, expect, it } from 'vitest';
import {
  InvalidSnapshotError,
  UnsupportedSchemaVersionError,
  deserializeSnapshot,
  serializeSnapshot,
} from './serialization.js';

interface Fixture {
  schemaVersion: string;
  b: string;
  a: number;
}

describe('serializeSnapshot', () => {
  it('writes newline-terminated canonical JSON with sorted keys', () => {
    const text = serializeSnapshot<Fixture>({ schemaVersion: '1', b: 'two', a: 1 });
    expect(text).toBe('{"a":1,"b":"two","schemaVersion":"1"}\n');
  });
});

describe('deserializeSnapshot', () => {
  it('round-trips a snapshot', () => {
    const fixture: Fixture = { schemaVersion: '1', b: 'two', a: 1 };
    expect(deserializeSnapshot<Fixture>(serializeSnapshot(fixture))).toEqual(fixture);
  });

  it('rejects an unsupported schema version', () => {
    expect(() => deserializeSnapshot('{"schemaVersion":"9"}')).toThrow(
      UnsupportedSchemaVersionError,
    );
  });

  it('rejects invalid JSON', () => {
    expect(() => deserializeSnapshot('{')).toThrow(InvalidSnapshotError);
  });

  it('rejects non-object JSON', () => {
    expect(() => deserializeSnapshot('[1,2]')).toThrow(InvalidSnapshotError);
  });

  it('rejects a missing or non-string schema version', () => {
    expect(() => deserializeSnapshot('{}')).toThrow(InvalidSnapshotError);
    expect(() => deserializeSnapshot('{"schemaVersion":1}')).toThrow(InvalidSnapshotError);
  });
});
