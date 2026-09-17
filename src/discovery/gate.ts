import type { ConsentScope } from './consent.js';
import type { AccessPolicy } from '../runtime/types.js';

/**
 * The consent choke point (roadmap M8 #85). Every read outside the project is
 * classified into a scope, and this module is the single place that maps a
 * scope to the grant that authorises it. An adapter asks `grants`, so a new
 * adapter cannot decide a scope by inventing its own flag, and the inventory
 * test can enumerate the scopes against one function.
 *
 * - `user` covers the user harness, the external-gated parent instructions, and
 *   the managed scope.
 * - `install` covers installation and version metadata.
 *
 * External `.git` references are not a scope (ADR 0002 §2): they are not read
 * before consent at all, and `allowsOutsideProject` covers the residual
 * project-identity reads a granted run may perform.
 */
export function grants(access: AccessPolicy, scope: ConsentScope): boolean {
  return scope === 'user' ? access.user : access.install;
}
