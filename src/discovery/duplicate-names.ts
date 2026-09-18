import type { NativeOrigin, ObservedElement } from '../core/observed.js';

/** A single entry in a duplicate name group: its display path and origin. */
export interface DuplicateNameEntry {
  path: string;
  origin: NativeOrigin;
}

/**
 * Groups observed catalog elements by their contributed kind+name and returns
 * only the groups that appear more than once (design doc §6, #163). Each group
 * carries its entries (path + origin) sorted by path, plus origin-level flags.
 */
export interface DuplicateNameGroup {
  kind: string;
  name: string;
  entries: DuplicateNameEntry[];
  /** True when every element in the group has origin `'plugin'`. */
  pluginOnly: boolean;
  /** True when any element in the group has origin `'plugin'`. */
  hasPlugin: boolean;
}

/**
 * Finds catalog names defined more than once. The `identityOf` callback derives
 * the contributed kind+name from each element (returning `null` to skip non-
 * catalog elements). Only `observed` elements participate: a skipped symlink or
 * unreadable file is not a competing definition.
 */
export function duplicateNameGroups(
  elements: readonly ObservedElement[],
  identityOf: (element: ObservedElement) => { kind: string; name: string } | null,
): DuplicateNameGroup[] {
  const byKey = new Map<
    string,
    { kind: string; name: string; entries: DuplicateNameEntry[]; origins: Set<NativeOrigin> }
  >();

  for (const element of elements) {
    if (element.status !== 'observed') continue;
    const identity = identityOf(element);
    if (identity === null) continue;

    const key = `${identity.kind}\0${identity.name}`;
    const group = byKey.get(key);
    const entry: DuplicateNameEntry = {
      path: element.source.path ?? '',
      origin: element.native.origin,
    };
    if (group === undefined) {
      byKey.set(key, {
        kind: identity.kind,
        name: identity.name,
        entries: [entry],
        origins: new Set([element.native.origin]),
      });
    } else {
      group.entries.push(entry);
      group.origins.add(element.native.origin);
    }
  }

  const result: DuplicateNameGroup[] = [];
  for (const { kind, name, entries, origins } of byKey.values()) {
    if (entries.length <= 1) continue;
    result.push({
      kind,
      name,
      entries: [...entries].sort((a, b) => a.path.localeCompare(b.path)),
      pluginOnly: origins.size === 1 && origins.has('plugin'),
      hasPlugin: origins.has('plugin'),
    });
  }
  return result;
}
