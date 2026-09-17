import type { Diagnostic } from '../core/diagnostics.js';
import type { RuntimeId } from '../core/ids.js';
import type { ObservedElement, ObservedSnapshot } from '../core/observed.js';
import type {
  Activation,
  Applicability,
  ResolutionStrategy,
  ResolvedSnapshot,
} from '../core/resolved.js';
import type { VersionPosition } from './version-compat.js';

/**
 * Runtime adapters (design doc §8). Adapters own known config locations,
 * known user/project/managed scopes, native formats, runtime-specific
 * discovery, precedence and accumulation rules, safe metadata extraction,
 * and runtime-version compatibility metadata. They do not own semantic
 * classification, findings, graph layout, or quality evaluation.
 */

/** The inspected project (design doc §16). */
export interface ProjectContext {
  id: string;
  displayName: string;
  /** Canonical repository root, or canonical absolute path for a non-Git directory. */
  root: string;
  /** Canonical remote URL, when the project is a Git repository. */
  remote?: string;
}

/**
 * Whether a runtime is present and usable. The design document does not fix
 * this shape; it is a provisional scaffold shape.
 */
export interface RuntimeDetection {
  runtimeId: RuntimeId;
  /**
   * `yes` only when a known installation was actually found; `no` when detection
   * looked and found nothing; `unknown` when detection could not look (consent
   * was not granted). The third state keeps "not consented" distinguishable from
   * "not installed" (roadmap §5 M7, issue #76).
   */
  installed: 'yes' | 'no' | 'unknown';
  /** null = version could not be determined; never guess a fallback value. */
  version: string | null;
  /** Whether the detected version falls inside the adapter's verified range. */
  runtimeCompatibility: 'verified' | 'unverified';
  /** Why detection reported what it did; never fatal (design doc §17, §18). */
  diagnostics: Diagnostic[];
}

/** One element's four resolution axes, as an adapter determined them (design doc §11). */
export interface ResolutionAxes {
  applicability: Applicability;
  strategy: ResolutionStrategy;
  activation: Activation;
}

/**
 * The resolution semantics an adapter selects for a detected version (design doc
 * §17). `axesFor` is the mapping `resolve()` walks; `position` says where the
 * version sits relative to the verified range. The branch exists so a version
 * that changes resolution semantics selects a different mapping here, next to
 * the tables it selects, rather than in detection.
 */
export interface ResolutionSemantics {
  position: VersionPosition;
  axesFor: (element: ObservedElement) => ResolutionAxes;
}

/**
 * Read consent for scopes outside the inspected project (design doc §19, §24).
 * Project-local discovery is implicit; anything else requires explicit consent,
 * stored per runtime + scope.
 */
export interface AccessPolicy {
  /** True only when the user has consented to reads outside the project. */
  allowOutsideProject: boolean;
  /** Granted scopes, keyed per runtime + scope (design doc §19). */
  grantedScopes: readonly string[];
}

/**
 * `home` is an environment override used to locate user-scope files; it defaults
 * to the user's home directory and lets callers run against an isolated home.
 * `pathValue` is the `PATH` detection scans for a runtime that is not
 * installer-managed; it defaults to `process.env.PATH` and lets callers run
 * against an isolated `PATH` (issue #76).
 */
export interface RuntimeAdapter {
  id(): RuntimeId;

  detect(
    project: ProjectContext,
    access: AccessPolicy,
    home?: string,
    pathValue?: string,
  ): Promise<RuntimeDetection>;

  discover(
    project: ProjectContext,
    access: AccessPolicy,
    home?: string,
    pathValue?: string,
  ): Promise<ObservedSnapshot>;

  resolve(observed: ObservedSnapshot, home?: string): Promise<ResolvedSnapshot>;
}
