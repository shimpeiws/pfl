import { EXIT_CODES, PflError } from '../cli/exit-codes.js';
import { runtimeId } from '../core/ids.js';
import type { ConsentLocationGroup, ConsentRequest } from '../discovery/consent.js';
import { ClaudeCodeAdapter } from './claude-code/index.js';
import {
  CONSENT_GROUPS as CLAUDE_CODE_CONSENT_GROUPS,
  RUNTIME_NAME as CLAUDE_CODE_RUNTIME_NAME,
} from './claude-code/consent.js';
import { CodexAdapter } from './codex/index.js';
import {
  CONSENT_GROUPS as CODEX_CONSENT_GROUPS,
  RUNTIME_NAME as CODEX_RUNTIME_NAME,
} from './codex/consent.js';
import type { RuntimeAdapter } from './types.js';

/**
 * The only module allowed to import concrete RuntimeAdapters. Everything else
 * must go through `getAdapter(id)`, so the core stays adapter-agnostic
 * (design doc §8).
 */
const ADAPTERS: Record<string, () => RuntimeAdapter> = {
  'claude-code': () => new ClaudeCodeAdapter(),
  codex: () => new CodexAdapter(),
};

export function getAdapter(id: string): RuntimeAdapter {
  const factory = ADAPTERS[id];
  if (!factory) {
    throw new PflError(`unknown runtime: ${id}`, EXIT_CODES.RUNTIME_UNSUPPORTED);
  }
  return factory();
}

export function listRuntimeIds(): string[] {
  return Object.keys(ADAPTERS);
}

/** Consent scope names frozen for v1.0 (roadmap M8 #81). */
export const CONSENT_SCOPES = ['user', 'install'] as const;
export type ConsentScope = (typeof CONSENT_SCOPES)[number];

/** Consent locations per runtime and scope, owned by the adapters (design doc §24). */
const CONSENT: Record<
  string,
  { runtimeName: string; groups: Record<ConsentScope, readonly ConsentLocationGroup[]> }
> = {
  'claude-code': {
    runtimeName: CLAUDE_CODE_RUNTIME_NAME,
    groups: CLAUDE_CODE_CONSENT_GROUPS,
  },
  codex: { runtimeName: CODEX_RUNTIME_NAME, groups: CODEX_CONSENT_GROUPS },
};

const RUNTIME_NAMES: Record<string, string> = {
  'claude-code': CLAUDE_CODE_RUNTIME_NAME,
  codex: CODEX_RUNTIME_NAME,
};

/** Human-readable runtime name for rendering (design doc §26); falls back to the id. */
export function getRuntimeName(id: string): string {
  return RUNTIME_NAMES[id] ?? id;
}

/** Builds the consent request for one runtime + scope (roadmap M8 #81). */
export function getConsentRequest(id: string, scope: ConsentScope = 'user'): ConsentRequest {
  const entry = CONSENT[id];
  if (!entry) {
    throw new PflError(`unknown runtime: ${id}`, EXIT_CODES.RUNTIME_UNSUPPORTED);
  }
  return {
    runtimeId: runtimeId(id),
    runtimeName: entry.runtimeName,
    scope,
    groups: entry.groups[scope],
  };
}
