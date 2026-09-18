import { homedir } from 'node:os';
import { runtimeId, type RuntimeId } from '../../core/ids.js';
import type { ObservedSnapshot } from '../../core/observed.js';
import type { ResolvedSnapshot } from '../../core/resolved.js';
import type { AccessPolicy, ProjectContext, RuntimeAdapter, RuntimeDetection } from '../types.js';
import { grants } from '../../discovery/gate.js';
import { installScopeNotGranted } from '../scaffold.js';
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
    if (!grants(access, 'install')) {
      return installScopeNotGranted(this.id());
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
