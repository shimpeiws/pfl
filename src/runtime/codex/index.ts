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

  async detect(_project: ProjectContext, access: AccessPolicy): Promise<RuntimeDetection> {
    if (!access.allowOutsideProject) {
      return {
        runtimeId: this.id(),
        installed: false,
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
    return detectCodex();
  }

  async discover(project: ProjectContext, access: AccessPolicy): Promise<ObservedSnapshot> {
    return discoverCodex(project, access);
  }

  async resolve(observed: ObservedSnapshot): Promise<ResolvedSnapshot> {
    return resolveCodex(observed);
  }
}
