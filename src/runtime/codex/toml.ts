import {
  MAX_PARSE_BYTES,
  MAX_TOML_ARRAY_ITEMS,
  MAX_TOML_SCALAR_LENGTH,
  MAX_TOML_SECTION_DEPTH,
} from '../../limits.js';

/**
 * A reader for Codex's `config.toml` (roadmap §5 M7, issue #74). It is
 * deliberately not a general TOML parser: it understands top-level and
 * section-scoped `key = value` scalars, string/boolean/integer values, and
 * arrays of those, and it never evaluates anything. Inline tables, datetimes,
 * and any other structure are recorded as malformed rather than guessed.
 *
 * Safety properties are preserved from the minimal reader it replaces:
 *
 * - No recursion and no object merging: the tree is built from `Map`s, so a
 *   hostile `__proto__` key or section cannot reach `Object.prototype`.
 * - Assignments are direct and unambiguous: the `=` is found by a linear scan
 *   outside strings, and values are parsed by first character, so there is no
 *   catastrophic backtracking.
 * - The section header is scanned linearly and bounded by `MAX_TOML_SECTION_DEPTH`
 *   (the old `/^\[\[?\s*(.+?)\s*\]\]?$/` was quadratic on an unterminated line).
 * - Arrays, scalars, and the parse input are bounded; a limit hit marks the file
 *   malformed, and the caller records a diagnostic.
 */

export type TomlScalar = string | number | boolean | readonly (string | number | boolean)[];

export interface TomlTable {
  readonly scalars: Map<string, TomlScalar>;
  readonly tables: Map<string, TomlTable>;
}

export interface TomlFacts {
  /** The document root; sections are `root.tables`, top-level scalars `root.scalars`. */
  root: TomlTable;
  /** True when a line, section, or value could not be read. Never thrown. */
  malformed: boolean;
}

function newTable(): TomlTable {
  return { scalars: new Map(), tables: new Map() };
}

export function readTomlFacts(text: string): TomlFacts {
  const root = newTable();
  const state = { malformed: false, current: root };
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = stripComment(lines[index] ?? '').trim();
    if (line === '') continue;

    if (line.startsWith('[')) {
      const path = parseSectionPath(line);
      if (path === null || path.length > MAX_TOML_SECTION_DEPTH) {
        state.malformed = true;
        continue;
      }
      state.current = getOrCreateTable(root, path);
      continue;
    }

    const equals = findAssignment(line);
    if (equals === -1) {
      state.malformed = true;
      continue;
    }
    const key = parseKey(line.slice(0, equals));
    if (key === null) {
      state.malformed = true;
      continue;
    }

    let valueText = line.slice(equals + 1).trim();
    if (valueText.startsWith('[')) {
      // TOML arrays may span lines. Accumulate until the brackets balance,
      // tracking depth incrementally so each character is scanned once (a
      // rescan of the whole buffer per line would be quadratic on a hostile
      // unterminated `[`), and bounded by the parse ceiling.
      const scan = startArrayScan(valueText);
      let total = valueText.length;
      while (!scan.closed && index + 1 < lines.length && total <= MAX_PARSE_BYTES) {
        index += 1;
        const chunk = ` ${stripComment(lines[index] ?? '').trim()}`;
        valueText += chunk;
        total += chunk.length;
        feedArrayScan(scan, chunk);
      }
    }

    const value = parseValue(valueText, state);
    if (value === undefined) {
      state.malformed = true;
      continue;
    }
    state.current.scalars.set(key, value);
  }

  return { root, malformed: state.malformed };
}

function getOrCreateTable(root: TomlTable, path: readonly string[]): TomlTable {
  let table = root;
  for (const segment of path) {
    let child = table.tables.get(segment);
    if (child === undefined) {
      child = newTable();
      table.tables.set(segment, child);
    }
    table = child;
  }
  return table;
}

/** Parses `[a.b]` / `[[a.b]]` into path segments, or null when unreadable. */
function parseSectionPath(line: string): string[] | null {
  const array = line.startsWith('[[');
  const open = array ? 2 : 1;
  const close = array ? ']]' : ']';
  if (!line.endsWith(close)) return null;
  const inner = line.slice(open, line.length - close.length).trim();
  if (inner === '') return null;
  return splitKeyPath(inner);
}

function splitKeyPath(inner: string): string[] | null {
  const segments: string[] = [];
  let index = 0;
  while (index < inner.length) {
    while (index < inner.length && /\s/.test(inner[index] ?? '')) index += 1;
    if (index >= inner.length) return null;

    const quote = inner[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      let segment = '';
      let closed = false;
      while (index < inner.length) {
        const char = inner[index] ?? '';
        if (quote === '"' && char === '\\' && index + 1 < inner.length) {
          segment += inner[index + 1];
          index += 2;
          continue;
        }
        if (char === quote) {
          index += 1;
          closed = true;
          break;
        }
        segment += char;
        index += 1;
      }
      if (!closed || segment === '') return null;
      segments.push(segment);
    } else {
      const start = index;
      while (index < inner.length && inner[index] !== '.' && !/\s/.test(inner[index] ?? '')) {
        index += 1;
      }
      const segment = inner.slice(start, index);
      if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
      segments.push(segment);
    }

    while (index < inner.length && /\s/.test(inner[index] ?? '')) index += 1;
    if (index >= inner.length) break;
    if (inner[index] !== '.') return null;
    index += 1;
  }
  return segments.length > 0 ? segments : null;
}

function parseKey(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    if (trimmed.length < 2 || trimmed[trimmed.length - 1] !== quote) return null;
    return unescape(trimmed.slice(1, -1), quote);
  }
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

type ParseState = { malformed: boolean };

function parseValue(text: string, state: ParseState): TomlScalar | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const first = trimmed[0];

  if (first === '"' || first === "'") {
    if (trimmed.length < 2 || trimmed[trimmed.length - 1] !== first) return undefined;
    return clampScalar(unescape(trimmed.slice(1, -1), first), state);
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);
  if (first === '[') {
    if (!startArrayScan(trimmed).closed) return undefined;
    return parseArray(trimmed, state);
  }
  return undefined;
}

function parseArray(text: string, state: ParseState): TomlScalar {
  const inner = text.slice(1, -1).trim();
  if (inner === '') return [];
  const parts = splitTopLevel(inner);
  const items: (string | number | boolean)[] = [];
  for (const part of parts) {
    if (items.length >= MAX_TOML_ARRAY_ITEMS) {
      state.malformed = true;
      break;
    }
    const value = parseScalarItem(part.trim(), state);
    if (value === undefined) {
      state.malformed = true;
      continue;
    }
    items.push(value);
  }
  return items;
}

function parseScalarItem(text: string, state: ParseState): string | number | boolean | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const first = trimmed[0];
  if (first === '"' || first === "'") {
    if (trimmed.length < 2 || trimmed[trimmed.length - 1] !== first) return undefined;
    return clampScalar(unescape(trimmed.slice(1, -1), first), state);
  }
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);
  return undefined;
}

/** Splits array/table body on top-level commas, respecting quoted strings. */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  let depth = 0;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index] ?? '';
    if (quote !== null) {
      current += char;
      if (quote === '"' && char === '\\' && index + 1 < inner.length) {
        current += inner[index + 1] ?? '';
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

interface ArrayScan {
  depth: number;
  quote: string | null;
  closed: boolean;
}

/** Begins tracking bracket depth and quote state for a possibly multi-line array. */
function startArrayScan(text: string): ArrayScan {
  const scan: ArrayScan = { depth: 0, quote: null, closed: false };
  feedArrayScan(scan, text);
  return scan;
}

/** Consumes one chunk into an existing scan; each character is visited once. */
function feedArrayScan(scan: ArrayScan, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (scan.quote !== null) {
      if (scan.quote === '"' && char === '\\') {
        index += 1;
        continue;
      }
      if (char === scan.quote) scan.quote = null;
      continue;
    }
    if (char === '"' || char === "'") scan.quote = char;
    else if (char === '[') scan.depth += 1;
    else if (char === ']') scan.depth -= 1;
  }
  scan.closed = scan.depth <= 0 && scan.quote === null;
}

/** The index of the first `=` outside a quoted string, or -1. */
function findAssignment(line: string): number {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? '';
    if (quote !== null) {
      if (quote === '"' && char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '=') return index;
  }
  return -1;
}

function clampScalar(value: string, state: ParseState): string {
  if (value.length > MAX_TOML_SCALAR_LENGTH) {
    state.malformed = true;
    return value.slice(0, MAX_TOML_SCALAR_LENGTH);
  }
  return value;
}

function unescape(value: string, quote: string): string {
  return quote === '"' ? value.replace(/\\(.)/g, '$1') : value;
}

/** Removes a `#` comment that is not inside a quoted string. */
function stripComment(line: string): string {
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote !== null && char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = quote === null ? char : quote === char ? null : quote;
    } else if (char === '#' && quote === null) {
      return line.slice(0, index);
    }
  }
  return line;
}
