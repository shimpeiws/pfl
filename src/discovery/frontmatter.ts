import type { SafeMetadataValue } from '../core/observed.js';
import {
  MAX_FRONTMATTER_KEYS,
  MAX_PARSE_BYTES,
  MAX_TOOL_NAME_LENGTH,
  MAX_TOOL_NAMES,
} from '../limits.js';

/**
 * Shared frontmatter reader (roadmap §5 M7, issue #68). Skills, subagents,
 * commands, rules, output styles, and memory files declare their identity in a
 * leading `---` fenced block; this module extracts only the *structural* facts
 * the safe-metadata allowlist admits — which keys are declared, the length of a
 * description, and declared tool and dependency names — so resolution is
 * possible without ever persisting instruction text.
 *
 * It is deliberately not a YAML implementation. It understands top-level
 * `key: value` lines, inline and block string lists, and block scalars well
 * enough to count and name them. It never recurses, never merges objects, and
 * never assigns an untrusted key to an object, so a hostile frontmatter cannot
 * reach a prototype. Malformed or unterminated input is reported, never thrown,
 * and the caller records a diagnostic (design doc §18).
 */

export interface FrontmatterFacts {
  /** True when an opening `---` fence was found, even if it was never closed. */
  hasFrontmatter: boolean;
  /** Declared top-level keys, in declaration order, deduplicated. */
  keys: string[];
  /** Declared tool names from `tools` or `allowed-tools`. */
  toolNames: string[];
  /** Declared skill dependency names from `dependencies`. */
  dependencyNames: string[];
  /** Character length of the `description` value; the value itself never leaves. */
  descriptionLength?: number;
}

export interface FrontmatterRead {
  facts: FrontmatterFacts;
  /** True when a fence was opened but not closed, or a body line could not be read. */
  malformed: boolean;
}

const OPENING_FENCE = /^---\s*$/;
const CLOSING_FENCE = /^(?:---|\.\.\.)\s*$/;
const TOP_LEVEL = /^([A-Za-z0-9_-]+)\s*:(.*)$/;
const BLOCK_ITEM = /^\s+-\s*(.*)$/;
const COMMENT = /^\s*#/;
const INDENTED = /^\s/;

const TOOL_KEYS = new Set(['tools', 'allowed-tools']);
const DEPENDENCY_KEYS = new Set(['dependencies']);
const BLOCK_SCALAR_MARKERS = new Set(['|', '>', '|-', '>-', '|+', '>+']);

/**
 * A declared tool name. Deliberately strict: an identifier, optionally with a
 * single parenthesized specifier (`Bash(git status:*)`, `mcp__server__tool`).
 * Anything with whitespace outside the parentheses is prose, not a tool name,
 * and is dropped so arbitrary shared-secret-shaped text is never persisted as a
 * tool name (the redaction layer remains the backstop for a name-shaped secret).
 */
const TOOL_NAME = /^[A-Za-z0-9_.-]+(\([^()\r\n]{0,200}\))?$/;

/**
 * A declared skill dependency name: a bare identifier, with no parenthesized
 * specifier. Prose and value-shaped fragments are dropped for the same reason
 * as an invalid tool name.
 */
const DEPENDENCY_NAME = /^[A-Za-z0-9_.-]+$/;

/** Reads the leading frontmatter block, if any, from file content. */
export function readFrontmatter(content: string): FrontmatterRead {
  // The walk already refuses a file over MAX_FILE_BYTES; this keeps the parse
  // input bounded by the same named limit the other parsers use (roadmap S7).
  const text = content.length > MAX_PARSE_BYTES ? content.slice(0, MAX_PARSE_BYTES) : content;
  const lines = stripBom(text).split(/\r?\n/);
  if (!OPENING_FENCE.test(lines[0] ?? '')) {
    return {
      facts: { hasFrontmatter: false, keys: [], toolNames: [], dependencyNames: [] },
      malformed: false,
    };
  }

  const close = lines.findIndex((line, index) => index > 0 && CLOSING_FENCE.test(line));
  const body = close === -1 ? lines.slice(1) : lines.slice(1, close);

  const keys: string[] = [];
  const seenKeys = new Set<string>();
  const toolNames: string[] = [];
  const seenTools = new Set<string>();
  const dependencyNames: string[] = [];
  const seenDependencies = new Set<string>();
  let descriptionLength: number | undefined;
  let overflow = false;

  let collecting: 'none' | 'tools' | 'dependencies' | 'description' = 'none';

  const addTools = (raw: string): void => {
    for (const candidate of splitTools(raw)) {
      // A candidate that is not a tool name (prose, or any value with spaces
      // outside parentheses) is dropped, not persisted as a fragment.
      if (!TOOL_NAME.test(candidate)) continue;
      if (candidate.length > MAX_TOOL_NAME_LENGTH) {
        overflow = true;
        continue;
      }
      if (toolNames.length >= MAX_TOOL_NAMES) {
        overflow = true;
        return;
      }
      if (!seenTools.has(candidate)) {
        seenTools.add(candidate);
        toolNames.push(candidate);
      }
    }
  };

  // A dependency name is the same kind of structural fragment as a tool name, so
  // it shares the identity and list-shape ceilings rather than inventing ones.
  const addDependencies = (raw: string): void => {
    for (const candidate of splitTools(raw)) {
      if (!DEPENDENCY_NAME.test(candidate)) continue;
      if (candidate.length > MAX_TOOL_NAME_LENGTH) {
        overflow = true;
        continue;
      }
      if (dependencyNames.length >= MAX_TOOL_NAMES) {
        overflow = true;
        return;
      }
      if (!seenDependencies.has(candidate)) {
        seenDependencies.add(candidate);
        dependencyNames.push(candidate);
      }
    }
  };

  let unreadable = false;
  for (const line of body) {
    if (line.trim() === '') continue;

    if (INDENTED.test(line)) {
      if (collecting === 'tools') {
        const item = BLOCK_ITEM.exec(line);
        if (item?.[1] !== undefined) addTools(item[1]);
      } else if (collecting === 'dependencies') {
        const item = BLOCK_ITEM.exec(line);
        if (item?.[1] !== undefined) addDependencies(item[1]);
      } else if (collecting === 'description') {
        descriptionLength = (descriptionLength ?? 0) + line.trim().length;
      }
      continue;
    }

    if (COMMENT.test(line)) continue;

    const match = TOP_LEVEL.exec(line);
    const key = match?.[1];
    if (key === undefined) {
      // A non-key, non-indented body line is not something this reader models.
      unreadable = true;
      collecting = 'none';
      continue;
    }

    if (!seenKeys.has(key)) {
      if (keys.length >= MAX_FRONTMATTER_KEYS) {
        overflow = true;
      } else {
        seenKeys.add(key);
        keys.push(key);
      }
    }

    const value = (match?.[2] ?? '').trim();
    if (TOOL_KEYS.has(key)) {
      collecting = 'none';
      if (value !== '') addTools(value);
      else collecting = 'tools';
    } else if (DEPENDENCY_KEYS.has(key)) {
      collecting = 'none';
      if (value !== '') addDependencies(value);
      else collecting = 'dependencies';
    } else if (key === 'description') {
      if (BLOCK_SCALAR_MARKERS.has(value)) {
        collecting = 'description';
        descriptionLength = 0;
      } else {
        collecting = 'none';
        descriptionLength = unquote(value).length;
      }
    } else {
      collecting = 'none';
    }
  }

  const facts: FrontmatterFacts = { hasFrontmatter: true, keys, toolNames, dependencyNames };
  if (descriptionLength !== undefined) facts.descriptionLength = descriptionLength;
  return { facts, malformed: close === -1 || unreadable || overflow };
}

/**
 * Maps frontmatter facts to the raw (not yet redacted or allowlisted) metadata
 * keys the adapters persist. Absent facts produce nothing, so the caller's
 * allowlist does not have to special-case an empty result.
 */
export function frontmatterMetadata(facts: FrontmatterFacts): Record<string, SafeMetadataValue> {
  if (!facts.hasFrontmatter) return {};
  const metadata: Record<string, SafeMetadataValue> = {
    hasFrontmatter: true,
    frontmatterKeys: facts.keys,
  };
  if (facts.toolNames.length > 0) metadata['toolNames'] = facts.toolNames;
  if (facts.dependencyNames.length > 0) metadata['dependencyNames'] = facts.dependencyNames;
  if (facts.descriptionLength !== undefined) {
    metadata['descriptionLength'] = facts.descriptionLength;
  }
  return metadata;
}

function splitTools(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === '') return [];
  const inner = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  // Only commas delimit a list. Whitespace-separated text is ambiguous with
  // prose, so a space-containing candidate is not split; the validator then
  // rejects it. Real declarations use commas or a YAML block list.
  return inner
    .split(',')
    .map((part) => unquote(part))
    .filter((part) => part !== '');
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
