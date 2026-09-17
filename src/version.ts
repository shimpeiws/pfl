import { readFileSync } from 'node:fs';

/**
 * The published pfl package version (`package.json` `version`). This is the
 * single source for the CLI (`cli.version()`) and for any recorded package
 * identity. It is distinct from the design version
 * (`docs/design/pfl-design-v0.1.md`) and from the snapshot schema version
 * (decided in `docs/design/adr/0001-snapshot-serialization-and-ids.md`).
 *
 * `package.json` is read as data, never executed: `new URL('../package.json',
 * import.meta.url)` resolves to the package root from both a source checkout
 * (`src/version.ts`) and the packed tarball (`dist/version.js`, one level below
 * the manifest).
 */
export const packageVersion: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
