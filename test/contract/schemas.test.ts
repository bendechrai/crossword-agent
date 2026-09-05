import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchemaObject } from 'ajv/dist/2020.js';
// ajv-formats is CommonJS with only a default export, which from an ES module
// arrives as the namespace's `default`; TypeScript models that as the module
// type rather than the callable, hence the cast to its own exported type.
import * as ajvFormatsModule from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import { maxAccuracy } from '../../src/profiles/builtins.js';
import { ProfileSchema, type Profile } from '../../src/profiles/schema.js';
import type { NormalisedPuzzleFile, PuzzleIndexRow } from '../../src/puzzle/types.js';
import type { RunRecord } from '../../src/eval/types.js';

const addFormats = ajvFormatsModule.default as unknown as FormatsPlugin;

const root = fileURLToPath(new URL('../..', import.meta.url));

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as T;
}

function compile(schemaFile: string) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const schema = JSON.parse(readFileSync(`${root}schemas/${schemaFile}`, 'utf8')) as AnySchemaObject;
  return ajv.compile(schema);
}

/** The baseline profile from the spec, with promptVersion "1" per the plan. */
const baseline: Profile = {
  name: 'baseline',
  tier1: 'nvidia/Nemotron-3_5-Lightning',
  tier2: 'deepseek-ai/DeepSeek-V4-Pro',
  candidatesPerAsk: 10,
  calibration: 'rank',
  samples: 1,
  batchSize: 1,
  reasksPerSlot: 2,
  sampling: { temperature: 0.2, maxTokens: 512 },
  escalation: {
    policy: 'reask-first',
    clueUnderstoodThreshold: 0.4,
    maxTier2CallsPerPuzzle: 15,
    escalationsPerSlot: 1,
  },
  search: { ordering: 'margin', ldsLimitStart: 0, ldsLimitMax: 3, maxBacktracks: 200 },
  repair: { enabled: true, maxCalls: 30, maxEditDistance: 2 },
  budget: { usd: 0.5, tokens: 2_000_000, wallMs: 900_000 },
  rateLimit: { rpsFraction: 0.9, maxConcurrencyTier1: 8, maxConcurrencyTier2: 16 },
  promptVersion: '1',
};

describe('candidate-response.schema.json', () => {
  const validate = compile('candidate-response.schema.json');

  it('accepts the single-clue form', () => {
    const single = {
      clue_understood: 0.8,
      candidates: [
        { answer: 'ANIMAL', confidence: 0.6 },
        { answer: 'MAMMAL', confidence: 0.4 },
      ],
      notes: 'crossing_suspect: "12A"',
    };
    expect(validate(single), JSON.stringify(validate.errors)).toBe(true);
  });

  it('accepts the batched form from the spec', () => {
    const batched = {
      results: [
        {
          id: '12A',
          clue_understood: 0.8,
          candidates: [{ answer: 'ANIMAL', confidence: 0.6 }],
        },
      ],
    };
    expect(validate(batched), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects a response that is neither form', () => {
    expect(validate({ candidates: [] })).toBe(false);
    expect(validate({ clue_understood: 0.5 })).toBe(false);
    expect(validate({ clue_understood: 0.5, candidates: [{ answer: 'X' }] })).toBe(false);
  });

  it('rejects a confidence outside 0..1', () => {
    expect(
      validate({ clue_understood: 0.5, candidates: [{ answer: 'X', confidence: 2 }] }),
    ).toBe(false);
  });
});

describe('puzzle.schema.json', () => {
  const validate = compile('puzzle.schema.json');
  const fixtures = ['synthetic-5x5', 'synthetic-7x7'] as const;

  for (const name of fixtures) {
    it(`validates the ${name} fixture`, () => {
      const puzzle = readJson<NormalisedPuzzleFile>(`../fixtures/puzzles/${name}.json`);
      expect(validate(puzzle), JSON.stringify(validate.errors)).toBe(true);
    });

    it(`${name} has slots consistent with its solution grid`, () => {
      const puzzle = readJson<NormalisedPuzzleFile>(`../fixtures/puzzles/${name}.json`);
      expect(puzzle.solution).toHaveLength(puzzle.height);
      for (const slot of puzzle.slots) {
        expect(slot.cells).toHaveLength(slot.length);
        for (const [row, col] of slot.cells) {
          expect(puzzle.cells[row]?.[col]?.block).toBe(false);
          expect(puzzle.solution[row]?.[col]).toMatch(/^[A-Z]$/);
        }
      }
    });

    it(`${name} leaks no answer into any clue (B42)`, () => {
      const puzzle = readJson<NormalisedPuzzleFile>(`../fixtures/puzzles/${name}.json`);
      const answers = puzzle.slots.map((s) =>
        s.cells.map(([r, c]) => puzzle.solution[r]?.[c] ?? '').join(''),
      );
      for (const slot of puzzle.slots) {
        const stripped = slot.clue.toUpperCase().replace(/[^A-Z]/g, '');
        for (const answer of answers) {
          expect(
            stripped.includes(answer),
            `${slot.id} clue "${slot.clue}" leaks ${answer}`,
          ).toBe(false);
        }
      }
    });
  }

  it('rejects a puzzle file missing schemaVersion', () => {
    const puzzle = readJson<Record<string, unknown>>('../fixtures/puzzles/synthetic-5x5.json');
    delete puzzle['schemaVersion'];
    expect(validate(puzzle)).toBe(false);
  });
});

describe('puzzle-index.schema.json', () => {
  const validate = compile('puzzle-index.schema.json');

  const row: PuzzleIndexRow = {
    id: 'guardian-cryptic-30085',
    source: 'guardian',
    date: '2026-08-30',
    title: 'Cryptic crossword No 30,085',
    style: 'cryptic',
    width: 15,
    height: 15,
    slotCount: 32,
    files: {
      original: 'puzzles/guardian/guardian-cryptic-30085.json',
      normalised: 'puzzles/guardian/guardian-cryptic-30085.normalised.json',
    },
    schemaVersion: 1,
    parsedBy: 'guardian-json',
    addedAt: '2026-09-01T09:15:00.000Z',
    bestLetterAccuracy: 0.94,
    lastRunAt: '2026-09-02T18:00:00.000Z',
  };

  it('validates an index row', () => {
    expect(validate([row]), JSON.stringify(validate.errors)).toBe(true);
  });

  it('validates an empty index', () => {
    expect(validate([])).toBe(true);
  });

  it('accepts null metrics on a never-run puzzle', () => {
    const fresh: PuzzleIndexRow = { ...row, bestLetterAccuracy: null, lastRunAt: null, date: null };
    expect(validate([fresh]), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects a row without files', () => {
    const { files: _files, ...withoutFiles } = row;
    expect(validate([withoutFiles])).toBe(false);
  });
});

describe('run-record.schema.json', () => {
  const validate = compile('run-record.schema.json');

  const record: RunRecord = {
    runId: 'synthetic-5x5--baseline--20260903T101500Z--0a1b2c3d',
    timestamp: '2026-09-03T10:15:00.000Z',
    status: 'ok',
    puzzle: {
      id: 'synthetic-5x5',
      source: 'synthetic',
      style: 'american',
      stratum: 'american',
      size: '5x5',
      slots: 11,
    },
    profile: baseline,
    provenance: {
      gitCommit: '9304afa',
      nodeVersion: 'v22.11.0',
      packageVersion: '0.1.0',
      profileSource: 'builtin',
    },
    repeatIndex: 0,
    seed: null,
    models: { tier1: 'nvidia/Nemotron-3_5-Lightning', tier2: 'deepseek-ai/DeepSeek-V4-Pro' },
    accuracy: { letters: 1, words: 1, perfect: true, emptyCells: 0 },
    perSlot: [
      {
        slotId: '1A',
        clue: 'Cry of surprise',
        length: 2,
        truth: 'OH',
        filled: 'OH',
        correct: true,
        producedBy: 1,
        batchIndex: null,
        truthInCandidates: true,
        truthRank: 0,
        rejectCounts: {
          length: 1,
          charset: 0,
          pattern: 0,
          'clue-echo': 0,
          duplicate: 2,
          'rejected-before': 0,
        },
        parseFailures: 0,
        latencyMs: 412,
        usd: 0.000031,
        reasks: 0,
        escalated: false,
        candidatesSeen: 10,
        pickedRank: 0,
      },
    ],
    calls: {
      tier1: {
        count: 11,
        promptTokens: 3400,
        completionTokens: 1200,
        reasoningTokens: 0,
        usdBilled: 0.00061,
        usdCounterfactual: 0.00061,
        cacheHits: 0,
        avgLatencyMs: 380,
      },
      tier2: {
        count: 0,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        usdBilled: 0,
        usdCounterfactual: 0,
        cacheHits: 0,
        avgLatencyMs: 0,
      },
    },
    search: { backtracks: 3, discrepancies: 1, wipeouts: 0, ac3Reductions: 14 },
    repair: { proposals: 0, accepted: 0 },
    wallMs: 8123,
    budgetHits: [],
  };

  it('validates a run record', () => {
    expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
  });

  it('validates a partial run that hit a budget cap', () => {
    const partial: RunRecord = {
      ...record,
      status: 'partial',
      budgetHits: [{ cap: 'usd', limit: 0.5, actual: 0.51, atMs: 7000 }],
    };
    expect(validate(partial), JSON.stringify(validate.errors)).toBe(true);
  });

  it('validates an errored run', () => {
    const errored: RunRecord = {
      ...record,
      status: 'error',
      error: 'offline cache miss for 3D',
    };
    expect(validate(errored), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects an unknown budget cap name', () => {
    expect(
      validate({ ...record, budgetHits: [{ cap: 'nope', limit: 1, actual: 2, atMs: 3 }] }),
    ).toBe(false);
  });

  it("embeds a profile that round-trips through the profile schema", () => {
    expect(ProfileSchema.parse(record.profile)).toEqual(baseline);
  });

  // T72: T71 added `reasoning` and `constrainedSamples` to ProfileSchema, and
  // the max-accuracy built-in sets both; a run record carrying that profile
  // must still validate against the published schema (it did not until this
  // task added the two fields to $defs.profile below).
  it('validates a run record whose profile is the max-accuracy built-in (T72)', () => {
    const withMaxAccuracy: RunRecord = { ...record, profile: maxAccuracy };
    expect(validate(withMaxAccuracy), JSON.stringify(validate.errors)).toBe(true);
  });
});
