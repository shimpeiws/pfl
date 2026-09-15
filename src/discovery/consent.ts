import { notImplemented } from '../cli/exit-codes.js';
import type { RuntimeId } from '../core/ids.js';

/**
 * Consent boundary (design doc §19, §24). Project-local discovery is
 * implicit; reading outside the project requires explicit consent, stored per
 * runtime + scope.
 */

/** A stable key for one runtime + scope grant. */
export function consentScopeKey(runtimeId: RuntimeId, scope: string): string {
  return `${runtimeId}:${scope}`;
}

export interface ConsentStore {
  /** Granted scope keys, each produced by `consentScopeKey`. */
  grantedScopes: string[];
}

export async function loadConsentStore(): Promise<ConsentStore> {
  notImplemented('consent store loading');
}

export async function grantConsent(_scopeKey: string): Promise<void> {
  notImplemented('consent grant');
}
