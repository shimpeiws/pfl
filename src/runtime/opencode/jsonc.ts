/**
 * A bounded JSONC reader (model doc §2, issue #93). OpenCode accepts
 * `opencode.jsonc` with line and block comments and trailing commas, and the
 * repository had no JSONC reader. This strips exactly those two extensions
 * before handing the text to `JSON.parse`, so the adapter never evaluates the
 * document and never grows a general parser.
 *
 * The scanner is linear and string-aware: a `//` or `,` inside a quoted value
 * is content, not syntax, and a `\"` escape is respected. It allocates only the
 * output string, and the input is already bounded by `MAX_PARSE_BYTES` at the
 * read site, so a hostile document cannot make it loop or allocate without
 * limit. It is deliberately not a full JSON parser — an invalid document still
 * fails at `JSON.parse`, which is what the caller records as malformed.
 */

export interface JsoncRead {
  /** The parsed value, or `undefined` when the document did not parse. */
  value: unknown;
  /** True when the document was not valid JSON after comment/comma stripping. */
  malformed: boolean;
}

export function readJsonc(text: string): JsoncRead {
  const stripped = stripTrailingCommas(stripComments(text));
  try {
    return { value: JSON.parse(stripped) as unknown, malformed: false };
  } catch {
    return { value: undefined, malformed: true };
  }
}

function stripComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let index = 0;

  while (index < text.length) {
    const char = text[index] as string;
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      index += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }

    if (char === '/' && text[index + 1] === '/') {
      index += 2;
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }

    if (char === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 2; // consume `*/`; an unterminated comment consumes the rest
      // A space keeps the tokens on either side of the comment from joining
      // (`1/*c*/2` must not become `12`), so a document the runtime would reject
      // is not silently accepted with different data.
      out += ' ';
      continue;
    }

    out += char;
    index += 1;
  }
  return out;
}

/**
 * Removes a comma that is followed only by whitespace and then `}` or `]`. The
 * scan is string-aware, so a comma inside a value is never touched.
 */
function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ',') {
      let lookahead = index + 1;
      while (lookahead < text.length && isJsonWhitespace(text[lookahead] as string)) lookahead += 1;
      const next = text[lookahead];
      if (next === '}' || next === ']') continue; // drop the trailing comma
    }
    out += char;
  }
  return out;
}

function isJsonWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}
