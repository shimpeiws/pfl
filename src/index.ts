#!/usr/bin/env node
import { homedir } from 'node:os';
import cac from 'cac';
import { runDiff } from './cli/diff.js';
import { EXIT_CODES, PflError } from './cli/exit-codes.js';
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

function withErrorHandling<Args extends [...unknown[], CommonFlags]>(
  action: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    try {
      await action(...args);
    } catch (error) {
      const flags = (args[args.length - 1] ?? {}) as CommonFlags;
      const logger = redactingLogger(loggerForFlags(flags), flags.json ? 'export' : 'display', {
        home: homedir(),
      });
      if (error instanceof PflError) {
        logger.error(error.message);
        process.exitCode = error.exitCode;
        return;
      }
      logger.error(error instanceof Error ? error.message : String(error));
      process.exitCode = EXIT_CODES.INSPECTION_FAILED;
    }
  };
}

cli
  .command('inspect', 'Inspect one runtime harness without executing it')
  .option('--runtime <runtime>', 'Runtime to inspect: claude-code or codex')
  .option('--json', 'Output as JSON')
  .action(
    withErrorHandling(async (flags: { runtime?: string } & CommonFlags) => {
      if (!flags.runtime) {
        throw new PflError('--runtime is required (claude-code or codex)', EXIT_CODES.CONFIG_ERROR);
      }
      await runInspect(
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
    withErrorHandling(async (flags: { snapshot?: string } & CommonFlags) => {
      await runReport(
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
      async (
        flags: {
          snapshot?: string;
          facet?: string;
          origin?: string;
          status?: string;
        } & CommonFlags,
      ) => {
        await runList(
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
    withErrorHandling(async (elementId: string, flags: { snapshot?: string } & CommonFlags) => {
      await runShow(
        process.cwd(),
        elementId,
        {
          ...(flags.snapshot !== undefined ? { snapshot: flags.snapshot } : {}),
          json: flags.json ?? false,
        },
        loggerForFlags(flags),
      );
    }),
  );

cli
  .command('graph', 'Render provenance and resolution for a snapshot')
  .option('--snapshot <id>', 'Snapshot id (default: latest)')
  .option('--json', 'Output as JSON')
  .action(
    withErrorHandling(async (flags: { snapshot?: string } & CommonFlags) => {
      await runGraph(
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
    withErrorHandling(async (flags: CommonFlags) => {
      await runSnapshots(process.cwd(), { json: flags.json ?? false }, loggerForFlags(flags));
    }),
  );

cli
  .command('diff <snapshot-a> <snapshot-b>', 'Compare two snapshots')
  .option('--json', 'Output as JSON')
  .action(
    withErrorHandling(async (snapshotA: string, snapshotB: string, flags: CommonFlags) => {
      await runDiff(
        process.cwd(),
        snapshotA,
        snapshotB,
        { json: flags.json ?? false },
        loggerForFlags(flags),
      );
    }),
  );

cli.help();
cli.version(packageVersion);
cli.parse();
