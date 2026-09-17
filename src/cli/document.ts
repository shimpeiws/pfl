import type { Completeness, Diagnostic } from '../core/diagnostics.js';
import { redactDiagnostic, redactFreeText, type RedactionContext } from '../redact/output.js';
import { packageVersion } from '../version.js';
import { EXIT_CODES, PflError, type ExitCode } from './exit-codes.js';

/**
 * The `--json` document contract (design doc roadmap M8; `docs/design/pfl-json-contract.md`).
 *
 * A `--json` run writes exactly one JSON object to stdout. Every log line,
 * progress message, and human-readable warning goes to stderr instead. The
 * object is a common envelope — `pflVersion`, `command`, `ok`, `completeness`,
 * `diagnostics`, `data` — so a consumer can parse it without knowing which
 * command produced it. Only `data` varies by command.
 *
 * `ok` is true whenever the command did its job (partial results included) and
 * false exactly when the exit code is non-zero. `completeness` describes the
 * harness that was observed and is not implied by `ok`.
 */

/** What every command returns so the wrapper can build one envelope. */
export interface CommandOutcome<T = unknown> {
  data: T;
  /** Diagnostics surfaced by the command, in emission order. */
  diagnostics: Diagnostic[];
  /** Completeness of the harness the command observed, when it observed one. */
  completeness: Completeness;
}

export interface Envelope<T = unknown> {
  pflVersion: string;
  command: string;
  ok: boolean;
  completeness: Completeness;
  diagnostics: Diagnostic[];
  data: T;
}

/** Exit code number to its stable name; the reverse of `EXIT_CODES`. */
export const EXIT_CODE_NAMES = Object.fromEntries(
  Object.entries(EXIT_CODES).map(([name, code]) => [code, name]),
) as Record<ExitCode, keyof typeof EXIT_CODES>;

/**
 * Builds the success envelope. Diagnostics are redacted at the export level,
 * the same channel the persisted form uses. `data` is otherwise structural by
 * construction; the few commands that emit a stored file path (`show`, `graph`)
 * re-redact it at this boundary, because the document layer does not re-derive
 * fields that were redacted when the snapshot was persisted.
 */
export function buildDocument<T>(
  command: string,
  outcome: CommandOutcome<T>,
  ctx: RedactionContext,
): Envelope<T> {
  return {
    pflVersion: packageVersion,
    command,
    ok: true,
    completeness: outcome.completeness,
    diagnostics: outcome.diagnostics.map((diagnostic) =>
      redactDiagnostic(diagnostic, 'export', ctx),
    ),
    data: outcome.data,
  };
}

/**
 * Builds the failure envelope. Every non-zero exit emits one: `ok` is false and
 * `data.error` carries the stable exit-code name and a redacted message. A
 * `PflError` may add structured context (consent adds `missingScopes`).
 */
export function buildErrorDocument(
  command: string,
  error: unknown,
  ctx: RedactionContext,
): Envelope<Record<string, unknown>> {
  const exitCode: ExitCode =
    error instanceof PflError ? error.exitCode : EXIT_CODES.INSPECTION_FAILED;
  const message = error instanceof Error ? error.message : String(error);
  const missingScopes = error instanceof PflError ? error.data?.missingScopes : undefined;
  return {
    pflVersion: packageVersion,
    command,
    ok: false,
    completeness: 'unknown',
    diagnostics: [],
    data: {
      error: { code: EXIT_CODE_NAMES[exitCode], message: redactFreeText(message, 'export', ctx) },
      // `PflErrorContext` is a closed shape, so this explicit copy is the whole
      // of what an error may add — nothing free-form reaches stdout unredacted.
      ...(missingScopes !== undefined
        ? { missingScopes: missingScopes.map((scope) => redactFreeText(scope, 'export', ctx)) }
        : {}),
    },
  };
}

/** Writes the single stdout document; the only stdout a `--json` run produces. */
export function writeDocument(document: Envelope): void {
  process.stdout.write(`${JSON.stringify(document)}\n`);
}
