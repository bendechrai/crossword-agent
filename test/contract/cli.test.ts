import { describe, expect, it } from 'vitest';

import { buildProgram } from '../../src/cli/index.js';
import { ExitCode } from '../../src/cli/exit.js';
import { MIN_LEVEL } from '../../src/events/levels.js';

const SUBCOMMANDS = ['fetch', 'list', 'show', 'solve', 'bench', 'report', 'cache'] as const;

describe('the commander tree', () => {
  it('declares all seven subcommands', () => {
    const names = buildProgram()
      .commands.map((c) => c.name())
      .sort();
    expect(names).toEqual([...SUBCOMMANDS].sort());
  });

  it('declares the global options', () => {
    const flags = buildProgram()
      .options.map((o) => o.long)
      .filter((f): f is string => f !== undefined);
    expect(flags).toContain('--config');
    expect(flags).toContain('--cache-dir');
    expect(flags).toContain('--no-color');
  });

  function optionsOf(command: string): string[] {
    const cmd = buildProgram().commands.find((c) => c.name() === command);
    expect(cmd, `no ${command} subcommand`).toBeDefined();
    return (cmd?.options ?? []).map((o) => o.long).filter((f): f is string => f !== undefined);
  }

  it('declares every option on the spec solve line', () => {
    expect(optionsOf('solve')).toEqual(
      expect.arrayContaining([
        '--profile',
        '--tier1',
        '--tier2',
        '--verbose',
        '--watch',
        '--offline',
        '--offline-lenient',
        '--budget-usd',
        '--seed',
        '--trace',
        '--no-inference-log',
        '--out',
      ]),
    );
  });

  it('declares every option on the spec fetch line', () => {
    expect(optionsOf('fetch')).toEqual(
      expect.arrayContaining(['--series', '--date', '--from', '--to', '--limit', '--out', '--path']),
    );
  });

  it('declares every option on the spec bench line', () => {
    expect(optionsOf('bench')).toEqual(
      expect.arrayContaining([
        '--profiles',
        '--repeat',
        '--offline',
        '--offline-lenient',
        '--concurrency',
        '--max-usd',
        '--yes',
        '--no-inference-log',
        '--out',
      ]),
    );
  });

  it('declares every option on the spec report line', () => {
    expect(optionsOf('report')).toEqual(
      expect.arrayContaining([
        '--runs',
        '--compare',
        '--by',
        '--json',
        '--md',
        '--inference',
        '--since',
        '--until',
        '--model',
        '--run',
        '--slot',
        '--dump',
      ]),
    );
  });

  it('declares the list and show options', () => {
    expect(optionsOf('list')).toEqual(
      expect.arrayContaining(['--source', '--style', '--solved', '--json']),
    );
    expect(optionsOf('show')).toEqual(expect.arrayContaining(['--solution']));
  });

  it('declares the four cache subcommands', () => {
    const cache = buildProgram().commands.find((c) => c.name() === 'cache');
    const names = (cache?.commands ?? []).map((c) => c.name()).sort();
    expect(names).toEqual(['clear', 'export', 'import', 'stats']);
  });

  it('gives every subcommand a description, so --help is useful', () => {
    for (const cmd of buildProgram().commands) {
      expect(cmd.description(), `${cmd.name()} has no description`).not.toBe('');
    }
  });
});

describe('exit codes (B28)', () => {
  it('are exactly the documented table', () => {
    expect(ExitCode.OK).toBe(0);
    expect(ExitCode.UNEXPECTED).toBe(1);
    expect(ExitCode.USAGE).toBe(2);
    expect(ExitCode.NOT_FOUND).toBe(3);
    expect(ExitCode.OFFLINE_MISS).toBe(4);
    expect(ExitCode.PROVIDER).toBe(5);
    expect(ExitCode.BENCH_PARTIAL).toBe(6);
  });
});

describe('MIN_LEVEL', () => {
  it('puts the level-0 run skeleton at level 0', () => {
    expect(MIN_LEVEL['run:start']).toBe(0);
    expect(MIN_LEVEL['grid:init']).toBe(0);
    expect(MIN_LEVEL['run:end']).toBe(0);
    expect(MIN_LEVEL['score:final']).toBe(0);
  });

  it('assigns a level in 0..3 to every event type', () => {
    for (const [type, level] of Object.entries(MIN_LEVEL)) {
      expect([0, 1, 2, 3], `${type} has level ${String(level)}`).toContain(level);
    }
  });
});
