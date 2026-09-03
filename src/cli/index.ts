import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { Command, CommanderError } from 'commander';

import { benchCommand } from './bench.js';
import {
  cacheClearCommand,
  cacheExportCommand,
  cacheImportCommand,
  cacheStatsCommand,
} from './cache.js';
import { CliError, ExitCode, isCliError } from './exit.js';
import { fetchCommand } from './fetch.js';
import { listCommand } from './list.js';
import {
  increaseVerbosity,
  parseCsvOption,
  parseGroupBy,
  parseIntOption,
  parseUsdOption,
  type BenchOptions,
  type CacheClearOptions,
  type FetchOptions,
  type GlobalOptions,
  type ListOptions,
  type ReportOptions,
  type ShowOptions,
  type SolveOptions,
} from './options.js';
import { reportCommand } from './report.js';
import { showCommand } from './show.js';
import { solveCommand } from './solve.js';

function packageVersion(): string {
  // ../../package.json from src/cli/ and from dist/cli/ alike.
  const url = new URL('../../package.json', import.meta.url);
  const pkg: unknown = JSON.parse(readFileSync(url, 'utf8'));
  if (typeof pkg === 'object' && pkg !== null && 'version' in pkg) {
    const { version } = pkg;
    if (typeof version === 'string') return version;
  }
  return '0.0.0';
}

function globalsFrom(program: Command): GlobalOptions {
  const opts = program.opts<{ config?: string; cacheDir?: string; color?: boolean }>();
  const noColorEnv = process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '';
  return {
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    ...(opts.cacheDir !== undefined ? { cacheDir: opts.cacheDir } : {}),
    color: opts.color !== false && !noColorEnv,
  };
}

export function buildProgram(): Command {
  const program = new Command();

  // Before any subcommand is created, so they inherit it: commander copies the
  // exit callback onto a subcommand at the moment `.command()` builds it.
  program.exitOverride();

  program
    .name('xw')
    .description('LLM candidate oracle wrapped in a deterministic crossword constraint search')
    .version(packageVersion(), '-V, --version', 'print the version and exit')
    .option('--config <path>', 'config file to read instead of ./crossword.config.json')
    .option('--cache-dir <path>', 'candidate cache directory (overrides $CROSSWORD_CACHE_DIR)')
    .option('--no-color', 'disable coloured output');

  program
    .command('fetch')
    .description('download puzzles from a source, normalise them and index them')
    .argument('<source>', 'source id: guardian, xd or file')
    .option('--series <s>', 'series within the source, for example cryptic or quick')
    .option('--date <YYYY-MM-DD>', 'fetch the puzzle published on this date')
    .option('--from <YYYY-MM-DD>', 'start of a date range')
    .option('--to <YYYY-MM-DD>', 'end of a date range')
    .option('--limit <n>', 'how many puzzles to fetch (guardian caps this at 20)', parseIntOption, 1)
    .option('--out <dir>', 'where to write puzzles', 'puzzles/')
    .option('--path <dir|zip>', 'local corpus directory or zip, for the xd source')
    .action(async (source: string, opts: FetchOptions) => {
      await fetchCommand(source, opts, globalsFrom(program));
    });

  program
    .command('list')
    .description('list the puzzles in the local library')
    .option('--source <id>', 'only puzzles from this source')
    .option('--style <s>', 'only puzzles of this style: american, cryptic, quick or unknown')
    .option('--solved', 'only puzzles with a run at 100% letters', false)
    .option('--json', 'print JSON instead of a table', false)
    .action(async (opts: ListOptions) => {
      await listCommand(opts, globalsFrom(program));
    });

  program
    .command('show')
    .description('print a puzzle grid and its clue lists')
    .argument('<id>', 'puzzle id')
    .option('--solution', 'reveal the solution letters', false)
    .action(async (id: string, opts: ShowOptions) => {
      await showCommand(id, opts, globalsFrom(program));
    });

  program
    .command('solve')
    .description('solve a puzzle and write a run record')
    .argument('<id|path>', 'puzzle id from the library, or a path to a puzzle file')
    .option('--profile <name|path>', 'strategy profile', 'baseline')
    .option('--tier1 <model>', 'override the tier-1 model id')
    .option('--tier2 <model>', 'override the tier-2 model id')
    .option('-v, --verbose', 'increase verbosity (repeat for -vv and -vvv)', increaseVerbosity, 0)
    .option('--watch', 'full-frame grid renderer (needs a TTY)', false)
    .option('--offline', 'forbid the network; a cache miss is fatal (exit 4)', false)
    .option('--offline-lenient', 'as --offline, but degrade gracefully instead', false)
    .option('--budget-usd <n>', 'override the profile USD budget', parseUsdOption)
    .option('--seed <n>', 'seed the local PRNG used for tie-breaks and jitter', parseIntOption)
    .option('--trace', 'also write runs/<runId>.events.jsonl', false)
    .option('--no-inference-log', 'do not write the raw inference log')
    .option('--out <run.json>', 'where to write the run record')
    .action(async (target: string, opts: SolveOptions) => {
      await solveCommand(target, opts, globalsFrom(program));
    });

  program
    .command('bench')
    .description('run a puzzle set across a matrix of profiles')
    .argument('<puzzle-set>', 'a set file under sets/, or a glob of run targets')
    .requiredOption('--profiles <a,b,c>', 'profiles to run, comma separated', parseCsvOption)
    .option('--repeat <n>', 'repeats per (puzzle, profile)', parseIntOption, 1)
    .option('--offline', 'forbid the network; a cache miss is fatal (exit 4)', false)
    .option('--offline-lenient', 'as --offline, but degrade gracefully instead', false)
    .option('--concurrency <n>', 'puzzles in flight at once', parseIntOption, 2)
    .option('--max-usd <n>', 'abort the matrix above this spend', parseUsdOption, 25)
    .option('--yes', 'proceed even when the pre-flight estimate exceeds --max-usd', false)
    .option('--no-inference-log', 'do not write the raw inference log')
    .option('--out <dir>', 'where to write run records', 'runs/')
    .action(async (puzzleSet: string, opts: BenchOptions) => {
      await benchCommand(puzzleSet, opts, globalsFrom(program));
    });

  program
    .command('report')
    .description('aggregate run records, or the raw inference log')
    .option('--runs <glob>', 'run records to read', 'runs/*.json')
    .option('--compare <a,b>', 'print a paired table for these groups', parseCsvOption)
    .option('--by <group>', 'profile, puzzle, tier, stratum or batchIndex', parseGroupBy, 'profile')
    .option('--json', 'print JSON', false)
    .option('--md', 'print markdown, as committed under docs/benches/', false)
    .option('--inference', 'read logs/inference/*.jsonl instead of run records', false)
    .option('--since <date>', 'inference only: earliest day to include')
    .option('--until <date>', 'inference only: latest day to include')
    .option('--model <id>', 'inference only: filter by model id')
    .option('--run <runId>', 'inference only: filter by run id')
    .option('--slot <slotId>', 'inference only: filter by slot id')
    .option('--dump', 'inference only: print the full matching records as JSON', false)
    .action(async (opts: ReportOptions) => {
      await reportCommand(opts, globalsFrom(program));
    });

  const cache = program.command('cache').description('inspect and move the candidate cache');

  cache
    .command('stats')
    .description('entry count, disk bytes, hit rate and breakdowns')
    .action(async () => {
      await cacheStatsCommand(globalsFrom(program));
    });

  cache
    .command('clear')
    .description('remove cache entries')
    .option('--model <id>', 'only entries for this model')
    .option('--prompt-version <v>', 'only entries for this prompt version')
    .action(async (opts: CacheClearOptions) => {
      await cacheClearCommand(opts, globalsFrom(program));
    });

  cache
    .command('export')
    .description('write a tarball of the resolved cache directory')
    .argument('<file>', 'tarball to write')
    .action(async (file: string) => {
      await cacheExportCommand(file, globalsFrom(program));
    });

  cache
    .command('import')
    .description('read a cache tarball back into the resolved cache directory')
    .argument('<file>', 'tarball to read')
    .action(async (file: string) => {
      await cacheImportCommand(file, globalsFrom(program));
    });

  return program;
}

/**
 * The one top-level catch (B28). It prints a `CliError`'s message and hint to
 * stderr and returns its code; anything else is a bug, so its stack is printed
 * and the code is 1. Nothing else in the codebase calls `process.exit`.
 */
export async function main(argv: string[]): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
    return ExitCode.OK;
  } catch (e) {
    if (e instanceof CommanderError) {
      // --help and --version are reported this way, and are not failures.
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.help') return ExitCode.OK;
      if (e.code === 'commander.version') return ExitCode.OK;
      process.stderr.write(`${e.message}\n`);
      return ExitCode.USAGE;
    }
    if (isCliError(e)) {
      process.stderr.write(`${e.message}\n`);
      if (e.hint !== undefined) process.stderr.write(`hint: ${e.hint}\n`);
      return e.code;
    }
    const error = e instanceof Error ? e : new CliError(ExitCode.UNEXPECTED, String(e));
    process.stderr.write(`${error.stack ?? error.message}\n`);
    return ExitCode.UNEXPECTED;
  }
}

/** True when this module is the entry point rather than an import. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv);
}
