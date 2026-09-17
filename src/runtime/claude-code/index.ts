import { homedir } from 'node:os';
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
    return detectClaudeCode(home ?? homedir(), pathValue);
  }

  async discover(
    project: ProjectContext,
    access: AccessPolicy,
    home?: string,
    pathValue: string = process.env['PATH'] ?? '',
  ): Promise<ObservedSnapshot> {
    return discoverClaudeCode(project, access, home ?? homedir(), pathValue);
  }

  async resolve(observed: ObservedSnapshot, home?: string): Promise<ResolvedSnapshot> {
    return resolveClaudeCode(observed, home ?? '');
  }
}
