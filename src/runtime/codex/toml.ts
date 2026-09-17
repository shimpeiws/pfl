/**
 * A deliberately minimal reader for Codex's `config.toml`. It extracts the few
 * top-level string scalars and section names the adapter records, and never
 * evaluates anything: arrays, inline tables, and unknown structures are ignored
 * rather than guessed. It is not a general TOML parser, and sandbox/approval
 * values are read as opaque strings, never applied.
 *
 * It handles the shapes Codex actually writes — quoted and escaped scalar
 * values, `#` comments outside strings, and quoted section names such as
 * `[mcp_servers."some.name"]` — and ignores anything it does not understand.
 */

export interface TomlFacts {
  /** Top-level `key = "value"` string scalars. */
  values: Record<string, string>;
  /** Names under `[mcp_servers.<name>]`. */
  mcpServers: string[];
  /** Names under `[plugins.<name>]` / `[plugins."<name>"]`. */
  plugins: string[];
}

const ASSIGNMENT = /^([A-Za-z0-9_-]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/;

export function readTomlFacts(text: string): TomlFacts {
  // A null-prototype map: a hostile `__proto__ = "…"` scalar cannot reach
  // `Object.prototype` through an assignment (design invariants: prototype
  // pollution defense).
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  const mcpServers = new Set<string>();
  const plugins = new Set<string>();
  let inSection = false;

  for (const rawLine of text.split('\n')) {
    const line = stripComment(rawLine).trim();
    if (line === '') continue;

    const sectionMatch = /^\[\[?\s*(.+?)\s*\]\]?$/.exec(line);
    if (sectionMatch) {
      const name = sectionMatch[1];
      if (name !== undefined) registerSection(name, mcpServers, plugins);
      inSection = true;
      continue;
    }
    if (inSection) continue; // only top-level scalars are read

    const assignment = ASSIGNMENT.exec(line);
    const key = assignment?.[1];
    const value = assignment?.[2];
    if (key !== undefined && value !== undefined) values[key] = unescape(value);
  }

  return { values, mcpServers: [...mcpServers], plugins: [...plugins] };
}

function registerSection(section: string, mcpServers: Set<string>, plugins: Set<string>): void {
  const dot = findSeparatorDot(section);
  if (dot === -1) return;
  const head = section.slice(0, dot);
  const name = readFirstKey(section.slice(dot + 1));
  if (name === '') return;
  if (head === 'mcp_servers') mcpServers.add(name);
  if (head === 'plugins') plugins.add(name);
}

/** The first `.` outside a quoted key, or -1. */
function findSeparatorDot(section: string): number {
  let inString = false;
  for (let index = 0; index < section.length; index += 1) {
    const char = section[index];
    if (char === '\\' && inString) {
      index += 1;
      continue;
    }
    if (char === '"') inString = !inString;
    else if (char === '.' && !inString) return index;
  }
  return -1;
}

/** Reads one key segment: `"quoted.name"` (unescaped) or a bare key up to the next `.`. */
function readFirstKey(rest: string): string {
  if (rest.startsWith('"')) {
    let result = '';
    let index = 1;
    while (index < rest.length) {
      const char = rest[index];
      if (char === '\\' && index + 1 < rest.length) {
        result += rest[index + 1];
        index += 2;
        continue;
      }
      if (char === '"') break;
      result += char;
      index += 1;
    }
    return result;
  }
  const dot = rest.indexOf('.');
  return dot === -1 ? rest : rest.slice(0, dot);
}

function unescape(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

/** Removes a `#` comment that is not inside a double-quoted string. */
function stripComment(line: string): string {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString && char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    else if (char === '#' && !inString) return line.slice(0, index);
  }
  return line;
}
