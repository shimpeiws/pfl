import type { ConsentLocationGroup } from '../../discovery/consent.js';
import { CONFIG_FILE_NAMES, ELEMENT_DIRS, MANAGED_CONFIG_DIR } from './paths.js';
import { EXTERNAL_PREFIXES } from './detect.js';

/** Display name used in the consent prompt and inspect output. */
export const RUNTIME_NAME = 'OpenCode';

const USER_PREFIX = '~/.config/opencode';

/**
 * Locations the prompt lists before reading outside the project. Derived from
 * the same path constants discovery uses, so adding a search area to the adapter
 * updates the prompt instead of silently underreporting the read scope (roadmap
 * S2). `docs/security/read-paths.md` is the human cross-check.
 *
 * The declared `instructions`/`references` targets are **not** listed: `pfl`
 * records the declaration and never opens it (model doc §5.2), so it is not a
 * read the consent prompt must state.
 */
export const CONSENT_GROUPS: Record<'user' | 'install', readonly ConsentLocationGroup[]> = {
  user: [
    {
      title: 'User and external references',
      locations: [
        `${USER_PREFIX}/AGENTS.md`,
        '~/.claude/CLAUDE.md',
        ...CONFIG_FILE_NAMES.map((file) => `${USER_PREFIX}/${file}`),
        ...ELEMENT_DIRS.flatMap((spec) => spec.dirs.map((dir) => `${USER_PREFIX}/${dir}/**`)),
        '~/.claude/skills/**',
        '~/.agents/skills/**',
        // The managed scope is a system location read under the same
        // out-of-project consent. Listed here so the prompt states the real
        // read scope.
        ...CONFIG_FILE_NAMES.map((file) => `${MANAGED_CONFIG_DIR}/${file}`),
        '../ (parent directories, bounded)',
      ],
    },
  ],
  install: [
    {
      title: 'Installation and version metadata',
      locations: [
        // OpenCode has no installer-managed version source this adapter models,
        // so only the non-installer scan is listed: a bin directory's entries,
        // a `PATH` entry, and a Homebrew `Cellar` version directory. The npm
        // package name is not verified and is not read.
        ...EXTERNAL_PREFIXES.map((prefix) => `~/${prefix}/bin`),
        'PATH directories (non-installer install)',
        'Homebrew Cellar version directories',
      ],
    },
  ],
};
