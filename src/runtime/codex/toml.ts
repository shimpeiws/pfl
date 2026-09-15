/**
 * A deliberately minimal reader for Codex's `config.toml`. It extracts the few
 * top-level string scalars and section names the adapter records, and never
 * evaluates anything: arrays, inline tables, and unknown structures are ignored
 * rather than guessed. It is not a general TOML parser, and sandbox/approval
 * values are read as opaque strings, never applied.
 */

export interface TomlFacts {
  /** Top-level `key = "value"` string scalars. */
  values: Record<string, string>;
  /** Names under `[mcp_servers.<name>]`. */
  mcpServers: string[];
  /** Names under `[plugins.<name>]` / `[plugins."<name>"]`. */
  plugins: string[];
}

export function readTomlFacts(text: string): TomlFacts {
  const values: Record<string, string> = {};
  const mcpServers = new Set<string>();
  const plugins = new Set<string>();
  let section: string | null = null;

  for (const rawLine of text.split('\n')) {
    const line = stripComment(rawLine).trim();
    if (line === '') continue;

    const sectionMatch = /^\[\[?\s*(.+?)\s*\]\]?$/.exec(line);
    if (sectionMatch) {
      const name = sectionMatch[1] ?? null;
      section = name;
      if (name !== null) registerSection(name, mcpServers, plugins);
      continue;
    }
    if (section !== null) continue; // only top-level scalars are read

    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/.exec(line);
    const key = assignment?.[1];
    const value = assignment?.[2];
    if (key !== undefined && value !== undefined) values[key] = value;
  }

  return { values, mcpServers: [...mcpServers], plugins: [...plugins] };
}

function registerSection(section: string, mcpServers: Set<string>, plugins: Set<string>): void {
  const [head, name] = section.split('.');
  const unquoted = name === undefined ? undefined : name.replace(/^"|"$/g, '');
  if (unquoted === undefined) return;
  if (head === 'mcp_servers') mcpServers.add(unquoted);
  if (head === 'plugins') plugins.add(unquoted);
}

/** Removes a `#` comment that is not inside a double-quoted string. */
function stripComment(line: string): string {
  let inString = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') inString = !inString;
    else if (char === '#' && !inString) return line.slice(0, index);
  }
  return line;
}
