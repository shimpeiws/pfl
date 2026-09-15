import { runtimeId, type RuntimeId } from '../../core/ids.js';
import type { ObservedSnapshot } from '../../core/observed.js';
import type { ResolvedSnapshot } from '../../core/resolved.js';
import type { AccessPolicy, ProjectContext, RuntimeAdapter, RuntimeDetection } from '../types.js';
import { detectClaudeCode } from './detect.js';
import { discoverClaudeCode } from './discovery.js';
import { resolveClaudeCode } from './resolve.js';

/** Runtime adapter for Claude Code (design doc §8, §31.1). */
export class ClaudeCodeAdapter implements RuntimeAdapter {
  id(): RuntimeId {
    return runtimeId('claude-code');
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
    return detectClaudeCode();
  }

  async discover(project: ProjectContext, access: AccessPolicy): Promise<ObservedSnapshot> {
    return discoverClaudeCode(project, access);
  }

  async resolve(observed: ObservedSnapshot): Promise<ResolvedSnapshot> {
    return resolveClaudeCode(observed);
  }
}
