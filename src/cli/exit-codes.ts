/**
 * Process exit codes.
 *
 * The design document does not fix an exit-code table, so these values are
 * provisional for the scaffold and should be ratified (and documented in the
 * README) before v0.1 ships. They follow the shape used by `yuurei`: a
 * successful run is 0 and each failure maps to the stage that produced it.
 */
export const EXIT_CODES = {
  SUCCESS: 0,
  CONFIG_ERROR: 2,
  RUNTIME_UNSUPPORTED: 3,
  INSPECTION_FAILED: 4,
  CONSENT_REQUIRED: 5,
  SNAPSHOT_STORE_FAILED: 6,
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
  throw new PflError(`${what} is not implemented yet`, EXIT_CODES.CONFIG_ERROR);
}
