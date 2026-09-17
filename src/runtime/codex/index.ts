import { homedir } from 'node:os';
import { runtimeId, type RuntimeId } from '../../core/ids.js';
import type { ObservedSnapshot } from '../../core/observed.js';
import type { ResolvedSnapshot } from '../../core/resolved.js';
import type { AccessPolicy, ProjectContext, RuntimeAdapter, RuntimeDetection } from '../types.js';
import { detectCodex } from './detect.js';
import { discoverCodex } from './discovery.js';
import { resolveCodex } from './resolve.js';

/** Runtime adapter for Codex (design doc §8, §31.2). */
export class CodexAdapter implements RuntimeAdapter {
  id(): RuntimeId {
    return runtimeId('codex');
  }

  async detect(
    _project: ProjectContext,
    access: AccessPolicy,
    home?: string,
    pathValue: string = process.env['PATH'] ?? '',
  ): Promise<RuntimeDetection> {
    if (!access.install) {
      return {
        runtimeId: this.id(),
        // `unknown`, not `no`: detection could not look, so "not consented" stays
        // distinguishable from "not installed" (roadmap §5 M7, issue #76).
        installed: 'unknown',
        version: null,
        runtimeCompatibility: 'unverified',
        diagnostics: [
          {
            severity: 'info',
            code: 'consent-not-granted',
            message:
              'runtime detection reads installation metadata outside the project and needs consent',
          },
        ],
      };
    }
    return detectCodex(home ?? homedir(), pathValue);
  }

  async discover(
    project: ProjectContext,
    access: AccessPolicy,
    home?: string,
    pathValue: string = process.env['PATH'] ?? '',
  ): Promise<ObservedSnapshot> {
    return discoverCodex(project, access, home ?? homedir(), pathValue);
  }

  async resolve(observed: ObservedSnapshot, home?: string): Promise<ResolvedSnapshot> {
    return resolveCodex(observed, home ?? '');
  }
}
