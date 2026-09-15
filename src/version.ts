import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * The published pfl package version (`package.json` `version`). This is the
 * single source for the CLI (`cli.version()`) and for any recorded package
 * identity. It is distinct from the design version
 * (`docs/design/pfl-design-v0.1.md`) and from the snapshot schema version
 * (decided in `docs/design/adr/0001-snapshot-serialization-and-ids.md`).
 *
 * `createRequire(import.meta.url)` resolves `../package.json` relative to the
 * compiled module (`dist/version.js`), so it reaches the manifest both from a
 * source checkout and from the packed tarball (`dist/` sits at the package
 * root, exactly one level below `package.json`).
 */
export const packageVersion: string = require('../package.json').version;
