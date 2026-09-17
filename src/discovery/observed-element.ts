import { elementIdFor, type RuntimeId } from '../core/ids.js';
import type {
  Inspectability,
  NativeOrigin,
  ObservedElement,
  ObservedReason,
  ObservedStatus,
  SafeMetadataValue,
} from '../core/observed.js';

/**
 * Builds an ObservedElement from a discovered entry (design doc §13.2). The id
 * is derived deterministically from runtime + origin + path + kind, so the same
 * element keeps the same id across runs and two elements from one file with
 * different kinds never collide (ADR 0003). Metadata is expected to be
 * allowlisted and redacted by the caller before it reaches here.
 */
export interface ObservedElementInput {
  runtimeId: RuntimeId;
  origin: NativeOrigin;
  scope: string | null;
  kind: string;
  path: string;
  inspectability?: Inspectability;
  metadata?: Readonly<Record<string, SafeMetadataValue>>;
  digest?: string;
  sizeBytes?: number;
  symlink?: boolean;
  status?: ObservedStatus;
  reason?: ObservedReason;
}

export function buildObservedElement(input: ObservedElementInput): ObservedElement {
  const { digest, sizeBytes, symlink, reason } = input;
  return {
    id: elementIdFor({
      runtimeId: input.runtimeId,
      origin: input.origin,
      path: input.path,
      kind: input.kind,
    }),
    native: { kind: input.kind, origin: input.origin, scope: input.scope },
    source: {
      path: input.path,
      ...(digest !== undefined ? { digest } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(symlink !== undefined ? { symlink } : {}),
    },
    inspectability: input.inspectability ?? 'observable',
    metadata: { ...(input.metadata ?? {}) },
    status: input.status ?? 'observed',
    ...(reason !== undefined ? { reason } : {}),
  };
}
