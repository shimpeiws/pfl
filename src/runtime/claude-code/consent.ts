import type { ConsentLocationGroup } from '../../discovery/consent.js';
import { INSTALL_LOCATIONS, UPDATE_RESULT_FILE, VERSIONS_DIR } from './detect.js';
import {
  MANAGED_CONFIG_DIR,
  PROJECT_CONFIG_DIR,
  PROJECT_INSTRUCTION_FILES,
  PROJECT_MCP_FILE,
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
 * Locations the §24 prompt lists before reading outside the project. Derived
 * from the same path constants discovery uses, so adding a search area to the
 * adapter updates the prompt instead of silently underreporting the read scope
 * (roadmap S2). `docs/security/read-paths.md` is the human cross-check.
 */
export const CONSENT_GROUPS: readonly ConsentLocationGroup[] = [
  {
    title: 'Project',
    locations: [
      ...PROJECT_INSTRUCTION_FILES.map((file) => `./${file}`),
      `./${PROJECT_CONFIG_DIR}/**`,
      `./${PROJECT_MCP_FILE}`,
    ],
  },
  {
    title: 'User',
    locations: [
      `${USER_PREFIX}/${USER_INSTRUCTION_FILE}`,
      ...SETTINGS_FILES.map((file) => `${USER_PREFIX}/${file}`),
      ...USER_ELEMENT_DIRS.map((dir) => `${USER_PREFIX}/${dir}/**`),
      `${USER_PREFIX}/${USER_PROJECTS_DIR}/**/memory/**`,
      `${USER_PREFIX}/${USER_PLUGINS_DIR}/**`,
      '~/.claude.json',
      // The managed scope is a system location read under the same out-of-project
      // consent. It is listed here so the prompt states the real read scope.
      `${MANAGED_CONFIG_DIR}/${USER_INSTRUCTION_FILE}`,
      `${MANAGED_CONFIG_DIR}/${SETTINGS_FILES[0]}`,
    ],
  },
  {
    title: 'Installation and version metadata',
    locations: [
      ...INSTALL_LOCATIONS.map((location) => `~/${location}`),
      `~/${VERSIONS_DIR}`,
      `~/${UPDATE_RESULT_FILE}`,
    ],
  },
  {
    title: 'External references',
    locations: [
      '../ (parent directories, bounded)',
      'Plugin directories referenced by Claude Code config',
      'MCP configuration metadata',
    ],
  },
];
