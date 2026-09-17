import type { ConsentLocationGroup } from '../../discovery/consent.js';
import { EXTERNAL_PREFIXES, INSTALL_LOCATIONS } from './detect.js';
import {
  PROJECT_CONFIG_DIR,
  PROJECT_INSTRUCTION_FILES,
  PROJECT_SKILLS_DIR,
  USER_CONFIG_FILE,
  USER_ELEMENT_DIRS,
  USER_HOOKS_FILE,
  USER_INSTRUCTION_FILE,
} from './paths.js';

/** Display name used in the consent prompt and inspect output. */
export const RUNTIME_NAME = 'Codex';

const USER_PREFIX = '~/.codex';

/**
 * Locations the prompt lists before reading outside the project. Derived from
 * the same path constants discovery uses, so adding a search area to the
 * adapter updates the prompt instead of silently underreporting the read scope
 * (roadmap S2). `docs/security/read-paths.md` is the human cross-check.
 */
export const CONSENT_GROUPS: readonly ConsentLocationGroup[] = [
  {
    title: 'Project',
    locations: [
      ...PROJECT_INSTRUCTION_FILES.map((file) => `./${file}`),
      `./${PROJECT_CONFIG_DIR}/${PROJECT_SKILLS_DIR}/**`,
    ],
  },
  {
    title: 'User',
    locations: [
      `${USER_PREFIX}/${USER_CONFIG_FILE}`,
      `${USER_PREFIX}/${USER_INSTRUCTION_FILE}`,
      ...USER_ELEMENT_DIRS.map((dir) => `${USER_PREFIX}/${dir}/**`),
      `${USER_PREFIX}/${USER_HOOKS_FILE}`,
    ],
  },
  {
    title: 'Installation and version metadata',
    locations: [
      ...INSTALL_LOCATIONS.map((location) => `~/${location}`),
      // A non-installer install (npm global, Homebrew, PATH-only) is found by
      // reading a bin directory's entries and, when present, a package manifest
      // or Cellar version directory. Listed so the prompt states the real scope.
      ...EXTERNAL_PREFIXES.flatMap((prefix) => [
        `~/${prefix}/bin`,
        `~/${prefix}/lib/node_modules/**`,
      ]),
      'PATH directories (non-installer install)',
      'Homebrew Cellar version directories',
    ],
  },
  {
    title: 'External references',
    locations: ['../ (parent directories, bounded)', 'MCP configuration metadata'],
  },
];
