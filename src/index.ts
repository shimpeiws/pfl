#!/usr/bin/env node
import { homedir } from 'node:os';
import cac from 'cac';
import { runDiff } from './cli/diff.js';
import {
  buildDocument,
  buildErrorDocument,
  writeDocument,
  type CommandOutcome,
} from './cli/document.js';
import { EXIT_CODES, PflError } from './cli/exit-codes.js';
import { runGc } from './cli/gc.js';
import { runGraph } from './cli/graph.js';
import { runInspect } from './cli/inspect.js';
import { runList } from './cli/list.js';
import { loggerForFlags } from './cli/output.js';
import { runReport } from './cli/report.js';
import { runShow } from './cli/show.js';
import { runSnapshots } from './cli/snapshots.js';
import { redactingLogger } from './redact/output.js';
import { packageVersion } from './version.js';

const cli = cac('pfl');

interface CommonFlags {
  json?: boolean;
}

/**
 * Parses `gc --keep`. A value-less option arrives as `true` (and `--no-keep` as
 * `false`), and a whitespace-only string coerces to 0; each would silently
 * reclaim every run but the latest, so they are refused rather than clamped.
 */
function parseKeep(value: string | number | boolean | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean' || (typeof value === 'string' && value.trim() === '')) {
    throw new PflError('--keep requires a non-negative integer', EXIT_CODES.CONFIG_ERROR);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new PflError('--keep requires a non-negative integer', EXIT_CODES.CONFIG_ERROR);
  }
  return parsed;
}

/**
 * Wraps a command so a `--json` run emits exactly one document — the success
 * envelope on completion, or the failure envelope on any exit. The exit code is
 * set on every failure, exactly when `ok` is false. Human runs are unchanged.
 */
function withErrorHandling<Args extends [...unknown[], CommonFlags | undefined]>(
  command: string,
  action: (...args: Args) => Promise<CommandOutcome>,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    const flags = (args[args.length - 1] ?? {}) as CommonFlags;
    const json = flags.json === true;
    const ctx = { home: homedir() };
    try {
      const outcome = await action(...args);
      if (json) writeDocument(buildDocument(command, outcome, ctx));
    } catch (error) {
      if (json) {
        writeDocument(buildErrorDocument(command, error, ctx));
      } else {
        const logger = redactingLogger(loggerForFlags(flags), 'display', ctx);
        logger.error(error instanceof Error ? error.message : String(error));
      }
      process.exitCode = error instanceof PflError ? error.exitCode : EXIT_CODES.INSPECTION_FAILED;
    }
  };
}

cli
  .command('inspect', 'Inspect one runtime harness without executing it')
  .option('--runtime <runtime>', 'Runtime to inspect: claude-code or codex')
  .option('--json', 'Output as JSON')
  .action(
    withErrorHandling('inspect', async (flags: { runtime?: string } & CommonFlags) => {
      if (!flags.runtime) {
        throw new PflError('--runtime is required (claude-code or codex)', EXIT_CODES.CONFIG_ERROR);
      }
      return runInspect(
        process.cwd(),
        { runtime: flags.runtime, json: flags.json ?? false },
        loggerForFlags(flags),
      );
    }),
  );

cli
  .command('report', 'Interpret the latest (or named) snapshot')
  .option('--snapshot <id>', 'Snapshot id (default: latest)')
  .option('--json', 'Output as JSON')
  .action(
    withErrorHandling('report', async (flags: { snapshot?: string } & CommonFlags) => {
      return runReport(
        process.cwd(),
        {
          ...(flags.snapshot !== undefined ? { snapshot: flags.snapshot } : {}),
          json: flags.json ?? false,
        },
        loggerForFlags(flags),
      );
    }),
  );

cli
  .command('list', 'List elements from the latest (or named) snapshot')
  .option('--snapshot <id>', 'Snapshot id (default: latest)')
  .option('--facet <facet>', 'Filter by semantic facet')
  .option('--origin <origin>', 'Filter by native origin')
  .option('--status <status>', 'Filter by resolved status')
  .option('--json', 'Output as JSON')
  .action(
    withErrorHandling(
      'list',
      async (
        flags: {
          snapshot?: string;
          facet?: string;
          origin?: string;
          status?: string;
        } & CommonFlags,
      ) => {
        return runList(
          process.cwd(),
          {
            ...(flags.snapshot !== undefined ? { snapshot: flags.snapshot } : {}),
            ...(flags.facet !== undefined ? { facet: flags.facet } : {}),
            ...(flags.origin !== undefined ? { origin: flags.origin } : {}),
            ...(flags.status !== undefined ? { status: flags.status } : {}),
            json: flags.json ?? false,
          },
          loggerForFlags(flags),
        );
      },
    ),
  );

cli
  .command('show <element-id>', 'Drill into one element')
  .option('--snapshot <id>', 'Snapshot id (default: latest)')
  .option('--json', 'Output as JSON')
  .action(
    withErrorHandling(
      'show',
      async (elementId: string, flags: { snapshot?: string } & CommonFlags) => {
        return runShow(
          process.cwd(),
          elementId,
          {
            ...(flags.snapshot !== undefined ? { snapshot: flags.snapshot } : {}),
            json: flags.json ?? false,
          },
          loggerForFlags(flags),
        );
      },
    ),
  );

cli
  .command('graph', 'Render provenance and resolution for a snapshot')
  .option('--snapshot <id>', 'Snapshot id (default: latest)')
  .option('--json', 'Output as JSON')
  .action(
    withErrorHandling('graph', async (flags: { snapshot?: string } & CommonFlags) => {
      return runGraph(
        process.cwd(),
        {
          ...(flags.snapshot !== undefined ? { snapshot: flags.snapshot } : {}),
          json: flags.json ?? false,
        },
        loggerForFlags(flags),
      );
    }),
  );

cli
  .command('snapshots', 'List stored snapshots for the current project')
  .option('--json', 'Output as JSON')
  .action(
    withErrorHandling('snapshots', async (flags: CommonFlags) => {
      return runSnapshots(process.cwd(), { json: flags.json ?? false }, loggerForFlags(flags));
    }),
  );

cli
  .command('gc', 'Reclaim old snapshots and orphaned histories')
  .option('--dry-run', 'List what would be reclaimed without deleting')
  .option('--keep <n>', 'Runs to retain for this project (default 20)')
  .option('--prune-orphans', 'Also reclaim orphaned project directories')
  .option('--json', 'Output as JSON')
  .action(
    withErrorHandling(
      'gc',
      async (
        flags: {
          dryRun?: boolean;
          keep?: string | number | boolean;
          pruneOrphans?: boolean;
        } & CommonFlags,
      ) => {
        const keep = parseKeep(flags.keep);
        return runGc(
          process.cwd(),
          {
            dryRun: flags.dryRun ?? false,
            ...(keep !== undefined ? { keep } : {}),
            pruneOrphans: flags.pruneOrphans ?? false,
            json: flags.json ?? false,
          },
          loggerForFlags(flags),
        );
      },
    ),
  );

cli
  .command('diff <snapshot-a> [snapshot-b]', 'Compare two snapshots (default: latest)')
  .option('--json', 'Output as JSON')
  .action(
    withErrorHandling(
      'diff',
      async (
        snapshotA: string,
        snapshotBOrFlags: string | CommonFlags | undefined,
        maybeFlags: CommonFlags | undefined,
      ) => {
        // `cac` omits the second positional when it is not given and passes the
        // options object in its place, so it is recovered from either position.
        const flags = maybeFlags ?? (snapshotBOrFlags as CommonFlags) ?? {};
        const snapshotB = typeof snapshotBOrFlags === 'string' ? snapshotBOrFlags : undefined;
        return runDiff(
          process.cwd(),
          snapshotA,
          snapshotB,
          { json: flags.json ?? false },
          loggerForFlags(flags),
        );
      },
    ),
  );

cli.help();
cli.version(packageVersion);

/**
 * `cac` validates arguments — unknown options, missing required positionals,
 * unused extras — before it ever calls an action, so `withErrorHandling` never
 * sees those failures. Under `--json` they must still produce the failure
 * envelope; otherwise stdout would carry no document at all. Args are read from
 * `process.argv` because the parsed options are not available when parsing
 * itself fails. A parse failure is a configuration error (exit 2).
 */
function reportFailure(command: string, message: string): void {
  if (process.argv.includes('--json')) {
    writeDocument(
      buildErrorDocument(command, new PflError(message, EXIT_CODES.CONFIG_ERROR), {
        home: homedir(),
      }),
    );
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exitCode = EXIT_CODES.CONFIG_ERROR;
}

const HELP_OR_VERSION = new Set(['--help', '-h', '--version', '-v']);

try {
  cli.parse();
  // `cac` neither throws nor runs anything for an unknown command or for no
  // command at all: it just exits 0. That would break the contract's "a failure
  // always emits the envelope", so both are turned into a configuration error.
  // `--help`/`--version` also leave `matchedCommand` unset and are left alone.
  if (cli.matchedCommand === undefined && !process.argv.some((arg) => HELP_OR_VERSION.has(arg))) {
    const unknown = cli.args[0];
    if (unknown !== undefined) {
      reportFailure('pfl', `unknown command: ${unknown}`);
    } else if (process.argv.includes('--json')) {
      reportFailure('pfl', 'no command given');
    } else {
      cli.outputHelp();
    }
  }
} catch (error) {
  reportFailure(
    cli.matchedCommandName ?? 'pfl',
    error instanceof Error ? error.message : String(error),
  );
}
