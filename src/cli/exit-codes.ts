/**
 * Process exit codes, ratified for v0.1 and documented in the README.
 *
 * A successful run is 0; every failure maps to the stage that produced it.
 * `NOT_IMPLEMENTED` exists only while scaffold stubs remain and is removed once
 * the last one lands, so "not built yet" is never reported as "you
 * misconfigured something".
 */
export const EXIT_CODES = {
  SUCCESS: 0,
  CONFIG_ERROR: 2,
  RUNTIME_UNSUPPORTED: 3,
  INSPECTION_FAILED: 4,
  CONSENT_REQUIRED: 5,
  SNAPSHOT_STORE_FAILED: 6,
  /** Scaffold-only; removed when nothing is unimplemented. */
  NOT_IMPLEMENTED: 7,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export class PflError extends Error {
  constructor(
    message: string,
    public readonly exitCode: ExitCode,
  ) {
    super(message);
    this.name = 'PflError';
  }
}

/** Fails loudly for scaffold paths that exist as entry points but carry no logic yet. */
export function notImplemented(what: string): never {
  throw new PflError(`${what} is not implemented yet`, EXIT_CODES.NOT_IMPLEMENTED);
}
