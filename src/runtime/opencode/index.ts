import { homedir } from 'node:os';
import { runtimeId, type RuntimeId } from '../../core/ids.js';
import type { ObservedSnapshot } from '../../core/observed.js';
import type { ResolvedSnapshot } from '../../core/resolved.js';
import type { AccessPolicy, ProjectContext, RuntimeAdapter, RuntimeDetection } from '../types.js';
import { grants } from '../../discovery/gate.js';
import { installScopeNotGranted } from '../scaffold.js';
import { detectOpencode } from './detect.js';
import { discoverOpencode } from './discovery.js';
import { resolveOpencode } from './resolve.js';

/** Runtime adapter for OpenCode (design doc §8; model doc, issues #78, #93). */
export class OpencodeAdapter implements RuntimeAdapter {
  id(): RuntimeId {
    return runtimeId('opencode');
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
    return detectOpencode(home ?? homedir(), pathValue);
  }

  async discover(
    project: ProjectContext,
    access: AccessPolicy,
    home?: string,
    pathValue: string = process.env['PATH'] ?? '',
  ): Promise<ObservedSnapshot> {
    return discoverOpencode(project, access, home ?? homedir(), pathValue);
  }

  async resolve(observed: ObservedSnapshot, home?: string): Promise<ResolvedSnapshot> {
    return resolveOpencode(observed, home ?? '');
  }
}
