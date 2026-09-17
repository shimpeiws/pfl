import type { ConsentLocationGroup } from '../../discovery/consent.js';
import {
  EXTERNAL_PREFIXES,
  INSTALL_LOCATIONS,
  UPDATE_RESULT_FILE,
  VERSIONS_DIR,
} from './detect.js';
import {
  MANAGED_CONFIG_DIR,
  PROJECT_CONFIG_DIR,
  SETTINGS_FILES,
  USER_ELEMENT_DIRS,
  USER_INSTRUCTION_FILE,
  USER_PLUGINS_DIR,
  USER_PROJECTS_DIR,
} from './paths.js';

/** Display name used in the consent prompt and inspect output (design doc §24). */
export const RUNTIME_NAME = 'Claude Code';

const USER_PREFIX = `~/${PROJECT_CONFIG_DIR}`;

/**
 * Locations the §24 prompt lists before reading outside the project, grouped by
 * the scope that authorises them (roadmap M8 #81). Derived from the same path
 * constants discovery uses, so adding a search area to the adapter updates the
 * prompt instead of silently underreporting the read scope (roadmap S2).
 * `docs/security/read-paths.md` is the human cross-check, and the prompt-alignment
 * test asserts each scope covers exactly its inventory constants.
 *
 * Project-local discovery is implicit and needs no grant, so it is not a group;
 * the prompt states it separately.
 */
export const CONSENT_GROUPS: Record<'user' | 'install', readonly ConsentLocationGroup[]> = {
  user: [
    {
      title: 'User and external references',
      locations: [
        `${USER_PREFIX}/${USER_INSTRUCTION_FILE}`,
        ...SETTINGS_FILES.map((file) => `${USER_PREFIX}/${file}`),
        ...USER_ELEMENT_DIRS.map((dir) => `${USER_PREFIX}/${dir}/**`),
        `${USER_PREFIX}/${USER_PROJECTS_DIR}/**/memory/**`,
        `${USER_PREFIX}/${USER_PLUGINS_DIR}/**`,
        '~/.claude.json',
        // The managed scope is a system location read under the same
        // out-of-project consent. Listed here so the prompt states the real
        // read scope.
        `${MANAGED_CONFIG_DIR}/${USER_INSTRUCTION_FILE}`,
        `${MANAGED_CONFIG_DIR}/${SETTINGS_FILES[0]}`,
        '../ (parent directories, bounded)',
        'Plugin directories referenced by Claude Code config',
        'MCP configuration metadata',
      ],
    },
  ],
  install: [
    {
      title: 'Installation and version metadata',
      locations: [
        ...INSTALL_LOCATIONS.map((location) => `~/${location}`),
        `~/${VERSIONS_DIR}`,
        `~/${UPDATE_RESULT_FILE}`,
        // A non-installer install (npm global, Homebrew, PATH-only) is found by
        // reading a bin directory's entries and, when present, a package
        // manifest or Cellar version directory. Listed so the prompt states the
        // real scope.
        ...EXTERNAL_PREFIXES.flatMap((prefix) => [
          `~/${prefix}/bin`,
          `~/${prefix}/lib/node_modules/**`,
        ]),
        'PATH directories (non-installer install)',
        'Homebrew Cellar version directories',
      ],
    },
  ],
};
