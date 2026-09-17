/**
 * Process exit codes, ratified for v0.1 and documented in the README.
 *
 * A successful run is 0; every failure maps to the stage that produced it.
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

/**
 * The only structured context an error may contribute to the `--json` failure
 * document. It is a closed shape on purpose: the failure document is written
 * raw to stdout, so a free-form bag would let a future error leak a path or a
 * secret. Adding a field here is a deliberate, reviewable act.
 */
export interface PflErrorContext {
  /** Consent scope keys the run needed and did not have, e.g. `claude-code:user`. */
  missingScopes?: readonly string[];
}

export class PflError extends Error {
  constructor(
    message: string,
    public readonly exitCode: ExitCode,
    /** Structured context for the failure document; most errors have none. */
    public readonly data?: PflErrorContext,
  ) {
    super(message);
    this.name = 'PflError';
  }
}
