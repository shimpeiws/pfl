import { dirname, resolve } from 'node:path';
import type { Diagnostic } from '../core/diagnostics.js';
import {
  CELL_ID_PATTERN,
  SOURCE_PROJECT_CONTRACT_VERSION,
  SOURCE_PROJECT_CONTROL_CHARS_PATTERN,
  SOURCE_PROJECT_HEAD_MAX_CHARS,
  SOURCE_PROJECT_ID_PATTERN,
  SOURCE_PROJECT_ID_PREFIXES,
  SOURCE_PROJECT_ISSUER_MAX_CHARS,
  SOURCE_PROJECT_KINDS,
  SOURCE_PROJECT_REMOTE_MAX_CHARS,
  type AssertedSourceProject,
} from '../core/observed.js';
import { MAX_PARSE_BYTES } from '../limits.js';
import { redactFreeText, redactPath, type RedactionContext } from '../redact/output.js';
import { readTextFileGuarded } from '../util/fs.js';

/**
 * The source-project declaration contract (#217; yuurei #214).
 *
 * A caller that materializes the observed workspace elsewhere — yuurei's
 * isolation cell — cannot give pfl the source project's `.git`, so the
 * cell-local `project.id` pfl derives is the cell's, not the source's. The
 * caller instead *declares* the source identity through a versioned contract
 * file, exposed to the `pfl inspect` process as:
 *
 * - `YUUREI_SOURCE_PROJECT_FILE` — the contract's absolute path
 * - `YUUREI_SOURCE_PROJECT_ID` — a copy of `source_project.id`, cross-checked
 *   against the file when present
 *
 * The contract file is `{ "version": 1, "issuer": "yuurei", "cell_id",
 * "source_project": { "id", "kind", "remote"?, "source", "head" } }`. It is
 * caller-asserted provenance (ADR 0004, same stance as `--cell-id`): pfl
 * validates and bounds it, never re-derives it, and never reads host Git
 * metadata or walks outside the cell to reconstruct it. The file is the
 * authoritative channel; the env id alone is not a declaration. `source` is
 * tolerated in the input but never validated or persisted (deny-by-default;
 * it is a host path).
 *
 * A declaration that fails to validate is not recorded: the snapshot carries
 * no `provenance.sourceProject` and a warning diagnostic explains why — a
 * malformed assertion reads as unknown, never as an observed identity.
 */

export const SOURCE_PROJECT_FILE_ENV = 'YUUREI_SOURCE_PROJECT_FILE';
export const SOURCE_PROJECT_ID_ENV = 'YUUREI_SOURCE_PROJECT_ID';

export type SourceProjectDeclaration =
  | { status: 'absent' }
  | { status: 'declared'; sourceProject: AssertedSourceProject }
  | { status: 'invalid'; diagnostic: Diagnostic };

function declarationDiagnostic(
  code: string,
  message: string,
  path?: string,
): SourceProjectDeclaration {
  return {
    status: 'invalid',
    diagnostic: { severity: 'warning', code, message, ...(path !== undefined ? { path } : {}) },
  };
}

/**
 * Resolves the caller-declared source-project identity from the process
 * environment. `cellId`, when supplied, is the `--cell-id` the inspection was
 * invoked with; a contract naming a different cell is rejected.
 */
export async function resolveSourceProjectDeclaration(options: {
  env: Record<string, string | undefined>;
  cellId?: string;
  /** For redaction: the home directory stripped from recorded strings. */
  home?: string;
}): Promise<SourceProjectDeclaration> {
  const { env } = options;
  const fileEnv = env[SOURCE_PROJECT_FILE_ENV];
  const idEnv = env[SOURCE_PROJECT_ID_ENV];

  if (fileEnv === undefined || fileEnv === '') {
    // The env id alone is not the versioned contract: without the file there
    // is nothing to validate against, so the assertion is incomplete rather
    // than recorded with half its provenance.
    if (idEnv !== undefined && idEnv !== '') {
      return declarationDiagnostic(
        'source-project-declaration-incomplete',
        `${SOURCE_PROJECT_ID_ENV} is set but ${SOURCE_PROJECT_FILE_ENV} is not; ` +
          'the source-project declaration requires the contract file',
      );
    }
    return { status: 'absent' };
  }

  // The caller named this file; it is read like the `.git` gitdir pointer —
  // leaf must be a regular file (no symlink/hardlink) and the size is capped,
  // but the path may legitimately live outside the inspected root.
  const contractPath = resolve(fileEnv);
  const read = await readTextFileGuarded(contractPath, MAX_PARSE_BYTES, dirname(contractPath));
  if (read.status !== 'ok') {
    return declarationDiagnostic(
      'source-project-declaration-unreadable',
      `could not read the source-project contract: ${read.status}`,
      contractPath,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return declarationDiagnostic(
      'source-project-declaration-invalid',
      'source-project contract is not valid JSON',
      contractPath,
    );
  }

  return parseSourceProjectContract(parsed, env, options.cellId, contractPath, {
    home: options.home ?? '',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSourceProjectContract(
  value: unknown,
  env: Record<string, string | undefined>,
  cellId: string | undefined,
  contractPath: string,
  ctx: RedactionContext,
): SourceProjectDeclaration {
  const invalid = (message: string): SourceProjectDeclaration =>
    declarationDiagnostic('source-project-declaration-invalid', message, contractPath);

  if (!isRecord(value)) return invalid('source-project contract is not a JSON object');
  if (value['version'] !== SOURCE_PROJECT_CONTRACT_VERSION) {
    // The raw value is unvalidated caller text; only the supported constant is
    // reported, never what the contract claimed.
    return invalid(
      `unsupported source-project contract version (supported: ${SOURCE_PROJECT_CONTRACT_VERSION})`,
    );
  }

  const issuer = value['issuer'];
  if (
    typeof issuer !== 'string' ||
    issuer.length === 0 ||
    issuer.length > SOURCE_PROJECT_ISSUER_MAX_CHARS ||
    SOURCE_PROJECT_CONTROL_CHARS_PATTERN.test(issuer)
  ) {
    return invalid('source-project contract issuer is missing or out of bounds');
  }
  const contractCellId = value['cell_id'];
  if (typeof contractCellId !== 'string' || !CELL_ID_PATTERN.test(contractCellId)) {
    return invalid('source-project contract cell_id is missing or malformed');
  }

  const sourceProject = value['source_project'];
  if (!isRecord(sourceProject)) return invalid('source-project contract source_project is missing');
  const id = sourceProject['id'];
  if (typeof id !== 'string' || !SOURCE_PROJECT_ID_PATTERN.test(id)) {
    return invalid('source_project.id is missing or not a pfl project id (git|path-<hex16>)');
  }
  const kind = sourceProject['kind'];
  if (typeof kind !== 'string' || !(SOURCE_PROJECT_KINDS as readonly string[]).includes(kind)) {
    return invalid(`source_project.kind must be one of ${SOURCE_PROJECT_KINDS.join(', ')}`);
  }
  const kindNarrowed = kind as AssertedSourceProject['kind'];
  // `id`'s prefix encodes the derivation `kind` claims; a self-contradictory
  // identity is rejected whole rather than recorded half-guessed.
  if (!id.startsWith(SOURCE_PROJECT_ID_PREFIXES[kindNarrowed])) {
    return invalid('source_project.id does not agree with source_project.kind');
  }
  const remote = sourceProject['remote'];
  if (
    remote !== undefined &&
    (typeof remote !== 'string' ||
      remote.length === 0 ||
      remote.length > SOURCE_PROJECT_REMOTE_MAX_CHARS ||
      SOURCE_PROJECT_CONTROL_CHARS_PATTERN.test(remote))
  ) {
    return invalid('source_project.remote is out of bounds');
  }
  // `remote` describes the remote the `git-remote` derivation used; a
  // `local-path` declaration carrying one is self-contradictory.
  if (remote !== undefined && kindNarrowed !== 'git-remote') {
    return invalid('source_project.remote does not agree with source_project.kind');
  }
  const head = sourceProject['head'];
  if (
    head !== undefined &&
    (typeof head !== 'string' ||
      head.length === 0 ||
      head.length > SOURCE_PROJECT_HEAD_MAX_CHARS ||
      SOURCE_PROJECT_CONTROL_CHARS_PATTERN.test(head))
  ) {
    return invalid('source_project.head is out of bounds');
  }

  // Cross-checks: a declaration whose parts disagree is rejected whole —
  // which source an assertion names must be unambiguous.
  if (cellId !== undefined && contractCellId !== cellId) {
    return declarationDiagnostic(
      'source-project-declaration-mismatch',
      `source-project contract cell_id "${contractCellId}" does not match --cell-id "${cellId}"`,
      contractPath,
    );
  }
  const envId = env[SOURCE_PROJECT_ID_ENV];
  if (envId !== undefined && envId !== '' && envId !== id) {
    // The env value is unvalidated at this point, so it is not echoed into
    // the diagnostic — caller-supplied text does not reach the message
    // stream raw. The validated contract id still names what it disagrees
    // with.
    return declarationDiagnostic(
      'source-project-declaration-mismatch',
      `${SOURCE_PROJECT_ID_ENV} does not match the contract's source_project.id "${id}"`,
      contractPath,
    );
  }

  // The verbatim strings a caller asserted pass the same redaction layer as
  // observed text before persistence: `issuer`/`remote` take the free-text
  // treatment `project.remote` gets; `head` is digest-shaped, so it takes the
  // path treatment that skips the high-entropy catch-all which would destroy
  // a commit sha (it still masks credential- and assignment-shaped content).
  const redacted: AssertedSourceProject = {
    id,
    kind: kindNarrowed,
    ...(remote !== undefined ? { remote: redactFreeText(remote, 'persistence', ctx) } : {}),
    issuer: redactFreeText(issuer, 'persistence', ctx),
    contractVersion: SOURCE_PROJECT_CONTRACT_VERSION,
    ...(head !== undefined ? { head: redactPath(head, ctx) } : {}),
  };
  // Redaction can grow a value (`[redacted]` is longer than the credential run
  // it replaces). The snapshot reader holds the same bounds on the stored
  // value, so a post-redaction overflow would write an artifact that cannot be
  // read back — reject the declaration instead.
  if (
    redacted.issuer.length > SOURCE_PROJECT_ISSUER_MAX_CHARS ||
    (redacted.remote !== undefined && redacted.remote.length > SOURCE_PROJECT_REMOTE_MAX_CHARS) ||
    (redacted.head !== undefined && redacted.head.length > SOURCE_PROJECT_HEAD_MAX_CHARS)
  ) {
    return invalid('source_project fields exceed bounds after redaction');
  }
  return { status: 'declared', sourceProject: redacted };
}
