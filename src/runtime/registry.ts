import {
  CORE_FACET_MAPPINGS,
  mergeFacetMappings,
  mergeFindingKinds,
  type FacetMappings,
  type FindingKinds,
} from '../classify/mappings.js';
import { EXIT_CODES, PflError } from '../cli/exit-codes.js';
import { runtimeId } from '../core/ids.js';
import type { ConsentLocationGroup, ConsentRequest, ConsentScope } from '../discovery/consent.js';
import {
  FACET_MAPPINGS as CLAUDE_CODE_FACET_MAPPINGS,
  FINDING_KINDS as CLAUDE_CODE_FINDING_KINDS,
} from './claude-code/classify.js';
import {
  FACET_MAPPINGS as CODEX_FACET_MAPPINGS,
  FINDING_KINDS as CODEX_FINDING_KINDS,
} from './codex/classify.js';
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
 *
 * Registering a runtime is **one entry here**, carrying the adapter factory, its
 * display name, and its per-scope consent groups together (roadmap M9 #92).
 * Previously these were three parallel records keyed by the same string with no
 * link between them, so forgetting one surfaced at runtime when a user ran the
 * command. One record makes an incomplete **entry** — a missing field — a compile
 * error. It does not make a **missing entry** a compile error on its own; that is
 * guarded by `registry.test.ts`, which asserts `listRuntimeIds()` against the
 * registered set. To add a runtime: create its adapter, export its `RUNTIME_NAME`
 * and `CONSENT_GROUPS`, add a single entry below, and extend that assertion. The
 * registry stays internal and is not in `package.json` `exports` (the
 * CLI-and-schema-only contract).
 */
interface RuntimeRegistration {
  create: () => RuntimeAdapter;
  runtimeName: string;
  /** Consent locations per scope, owned by the adapter (design doc §24). */
  consentGroups: Record<ConsentScope, readonly ConsentLocationGroup[]>;
  /** The adapter's kind-to-facet contribution (roadmap M9 #91). */
  facetMappings: FacetMappings;
  /** The kinds the adapter's findings rules key on (roadmap M9 #91). */
  findingKinds: Partial<FindingKinds>;
}

const REGISTRY: Record<string, RuntimeRegistration> = {
  'claude-code': {
    create: () => new ClaudeCodeAdapter(),
    runtimeName: CLAUDE_CODE_RUNTIME_NAME,
    consentGroups: CLAUDE_CODE_CONSENT_GROUPS,
    facetMappings: CLAUDE_CODE_FACET_MAPPINGS,
    findingKinds: CLAUDE_CODE_FINDING_KINDS,
  },
  codex: {
    create: () => new CodexAdapter(),
    runtimeName: CODEX_RUNTIME_NAME,
    consentGroups: CODEX_CONSENT_GROUPS,
    facetMappings: CODEX_FACET_MAPPINGS,
    findingKinds: CODEX_FINDING_KINDS,
  },
};

export function getAdapter(id: string): RuntimeAdapter {
  const entry = REGISTRY[id];
  if (!entry) {
    throw new PflError(`unknown runtime: ${id}`, EXIT_CODES.RUNTIME_UNSUPPORTED);
  }
  return entry.create();
}

export function listRuntimeIds(): string[] {
  return Object.keys(REGISTRY);
}

/**
 * The semantic contribution of every registered adapter: its kind-to-facet
 * mappings and the kinds its findings rules key on, merged over the core table
 * (roadmap M9 #91). The classifier and findings consume this, so an adapter
 * introduces a kind without editing `src/classify/`.
 */
export function getClassifierContribution(): {
  mappings: FacetMappings;
  findingKinds: FindingKinds;
} {
  const registrations = Object.values(REGISTRY);
  return {
    mappings: mergeFacetMappings(
      CORE_FACET_MAPPINGS,
      ...registrations.map((entry) => entry.facetMappings),
    ),
    findingKinds: mergeFindingKinds(...registrations.map((entry) => entry.findingKinds)),
  };
}

/** Human-readable runtime name for rendering (design doc §26); falls back to the id. */
export function getRuntimeName(id: string): string {
  return REGISTRY[id]?.runtimeName ?? id;
}

/** Builds the consent request for one runtime + scope (roadmap M8 #81). */
export function getConsentRequest(id: string, scope: ConsentScope = 'user'): ConsentRequest {
  const entry = REGISTRY[id];
  if (!entry) {
    throw new PflError(`unknown runtime: ${id}`, EXIT_CODES.RUNTIME_UNSUPPORTED);
  }
  return {
    runtimeId: runtimeId(id),
    runtimeName: entry.runtimeName,
    scope,
    groups: entry.consentGroups[scope],
  };
}
