import { homedir } from 'node:os';
import { runtimeId, type RuntimeId } from '../../core/ids.js';
import type { ObservedSnapshot } from '../../core/observed.js';
import type { ResolvedSnapshot } from '../../core/resolved.js';
import type { AccessPolicy, ProjectContext, RuntimeAdapter, RuntimeDetection } from '../types.js';
import { grants } from '../../discovery/gate.js';
import { installScopeNotGranted } from '../scaffold.js';
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
    if (!grants(access, 'install')) {
      return installScopeNotGranted(this.id());
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
