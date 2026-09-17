/**
 * The synthetic `#fragment` convention for element display paths.
 *
 * One harness file can yield several elements: a Claude Code `settings.json`
 * yields permissions, hooks, MCP servers, output style, and plugins. Each
 * element's display path carries a fragment (`settings.json#permissions`) to
 * tell them apart and to name the config key the element belongs to. The
 * fragment is therefore both an id discriminator and the settings key that
 * cross-scope shadowing and the `conflicting-scope` finding group on.
 *
 * Building and parsing the fragment live here, in one place, so the convention
 * cannot drift between the adapters that emit it and the consumers that read it
 * back (ADR 0003).
 */

/** Separates a file's display path from its fragment key. */
const FRAGMENT_SEPARATOR = '#';

/** Builds the display path of a fragment element: `<file>#<key>`. */
export function withFragment(filePath: string, key: string): string {
  return `${filePath}${FRAGMENT_SEPARATOR}${key}`;
}

/**
 * The fragment key of a display path, or `null` when the path names a whole
 * file. A path with a bare `#` yields the empty string, exactly as the split it
 * replaces did.
 */
export function fragmentKeyOf(displayPath: string): string | null {
  const at = displayPath.indexOf(FRAGMENT_SEPARATOR);
  return at === -1 ? null : displayPath.slice(at + 1);
}
