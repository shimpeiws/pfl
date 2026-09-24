import type { ElementId } from '../core/ids.js';
import type {
  Activation,
  Applicability,
  ResolvedElement,
  ResolvedSnapshot,
  ResolvedStatus,
  ResolutionStrategy,
} from '../core/resolved.js';
import type { ObservedSnapshot } from '../core/observed.js';
import type { RuntimeAdapter } from '../runtime/types.js';

/**
 * Runtime-agnostic resolution core (design doc §11). The normalized model keeps
 * four axes separate — native source, applicability, resolution semantics, and
 * activation — because a single global precedence rank is insufficient.
 * Runtime-specific precedence and accumulation rules live in each adapter's
 * `resolve`, which uses this core to derive a `ResolvedStatus` from the axes.
 *
 * `effective` means the element can affect agent process or output under the
 * current static environment and runtime semantics (design doc §11). An
 * on-demand skill is therefore effective, not conditional: it is available to
 * the agent.
 */

/** One observed element's resolved axes, as an adapter determined them. */
export interface ElementResolutionInput {
  id: ElementId;
  applicability: Applicability;
  strategy: ResolutionStrategy;
  activation: Activation;
  /** Set when the adapter determined this element is overridden by another. */
  shadowedBy?: ElementId;
  /**
   * Set when the adapter determined the element is not in force for a known
   * reason (e.g. a marketplace catalog clone that is not installed, #176).
   * Resolves to `unresolved` carrying this reason.
   */
  unresolvedReason?: string;
}

/** Runtime-agnostic entry point (design doc §11): delegates to the adapter. */
export async function resolveHarness(
  adapter: RuntimeAdapter,
  observed: ObservedSnapshot,
  home?: string,
): Promise<ResolvedSnapshot> {
  return adapter.resolve(observed, home);
}

export function resolveElements(inputs: readonly ElementResolutionInput[]): ResolvedElement[] {
  return inputs.map((input) => resolveElement(input));
}

export function resolveElement(input: ElementResolutionInput): ResolvedElement {
  const { status, reason } = deriveStatus(input);
  return {
    id: input.id,
    status,
    applicability: input.applicability,
    activation: input.activation,
    resolution: { strategy: input.strategy, reason },
  };
}

function deriveStatus(input: ElementResolutionInput): { status: ResolvedStatus; reason: string } {
  if (input.unresolvedReason !== undefined) {
    return { status: 'unresolved', reason: input.unresolvedReason };
  }
  if (input.shadowedBy !== undefined) {
    return { status: 'shadowed', reason: `overridden by ${input.shadowedBy}` };
  }
  if (input.applicability.type === 'unknown') {
    return { status: 'unresolved', reason: 'applicability could not be determined' };
  }
  // A config rule and a conditional activation are known to be conditional even
  // when another axis is unknown; design §11 makes conditionality the answer.
  if (input.applicability.type === 'config-rule') {
    return {
      status: 'conditional',
      reason: 'a configuration rule applies conditionally',
    };
  }
  if (input.activation === 'conditional') {
    return {
      status: 'conditional',
      reason: 'activation is conditional and its condition is not statically determined',
    };
  }
  if (input.strategy === 'unknown' || input.activation === 'unknown') {
    return {
      status: 'unknown',
      reason: 'resolution could not be determined from static facts',
    };
  }
  return { status: 'effective', reason: effectiveReason(input) };
}

function effectiveReason(input: ElementResolutionInput): string {
  if (input.activation === 'on-demand') {
    return 'available on demand; still effective';
  }
  switch (input.strategy) {
    case 'accumulate':
      return 'accumulates with the other layers';
    case 'override':
      return 'overrides lower-precedence elements';
    case 'available':
      return 'available to the agent';
    case 'policy':
      return 'applies as policy';
    case 'event-pipeline':
      return 'runs as part of the event pipeline';
    case 'runtime-defined':
      return 'runtime-defined layer';
    default:
      return 'applies under the current environment';
  }
}
