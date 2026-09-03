import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { calibrate, loadCalibrationWeights } from '../../../src/score/calibrate.js';
import type { CalibrateOptions } from '../../../src/score/calibrate.js';
import { NotImplementedError } from '../../../src/util/errors.js';
import type { Candidate } from '../../../src/candidates/types.js';

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    answer: 'ANSWER',
    raw: 'answer',
    rank: 0,
    selfConfidence: 0.5,
    votes: 1,
    score: 0,
    tier: 1,
    fromCache: false,
    ...overrides,
  };
}

const rankOpts: CalibrateOptions = { mode: 'rank', samples: 1 };

describe('calibrate (rank mode)', () => {
  it('scores rank 0, 1, 2 as exactly 0.5, 1/3, 0.25', () => {
    const candidates = [candidate({ rank: 0 }), candidate({ rank: 1 }), candidate({ rank: 2 })];
    const result = calibrate(candidates, rankOpts);
    expect(result.map((c) => c.score)).toEqual([0.5, 1 / 3, 0.25]);
  });

  it('produces strictly decreasing scores as rank increases, without reordering the array', () => {
    const candidates = [
      candidate({ answer: 'THIRD', rank: 2 }),
      candidate({ answer: 'FIRST', rank: 0 }),
      candidate({ answer: 'SECOND', rank: 1 }),
    ];
    const result = calibrate(candidates, rankOpts);

    // Order is unchanged: same answers in the same positions as the input.
    expect(result.map((c) => c.answer)).toEqual(['THIRD', 'FIRST', 'SECOND']);

    // But scores are strictly decreasing in rank, regardless of position.
    const byRank = [...result].sort((a, b) => a.rank - b.rank);
    for (let i = 1; i < byRank.length; i += 1) {
      const prev = byRank[i - 1];
      const cur = byRank[i];
      if (prev === undefined || cur === undefined) throw new Error('unreachable');
      expect(cur.score).toBeLessThan(prev.score);
    }
  });

  it('returns an empty array for an empty candidate list, without throwing', () => {
    expect(calibrate([], rankOpts)).toEqual([]);
  });

  it('leaves every other field untouched', () => {
    const input = candidate({ rank: 3, selfConfidence: 0.9, votes: 2, tier: 2, fromCache: true });
    const [result] = calibrate([input], rankOpts);
    expect(result).toEqual({ ...input, score: 1 / 5 });
  });
});

describe('calibrate (unimplemented modes)', () => {
  it('throws NotImplementedError naming M6 for votes mode', () => {
    const candidates = [candidate()];
    let thrown: unknown;
    try {
      calibrate(candidates, { mode: 'votes', samples: 3 });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(NotImplementedError);
    expect((thrown as Error).message).toContain('M6');
  });

  it('throws NotImplementedError naming M6 for blend mode', () => {
    const candidates = [candidate()];
    let thrown: unknown;
    try {
      calibrate(candidates, { mode: 'blend', samples: 1, weights: { blend: [0.5, 0.4, 0.1] } });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(NotImplementedError);
    expect((thrown as Error).message).toContain('M6');
  });
});

describe('loadCalibrationWeights', () => {
  it('parses config/calibration.json and its weights sum to 1.0', () => {
    const weights = loadCalibrationWeights();
    expect(weights.blend).toHaveLength(3);
    const sum = weights.blend[0] + weights.blend[1] + weights.blend[2];
    expect(sum).toBe(1);
  });

  it('ships the placeholder weights [0.5, 0.4, 0.1]', () => {
    const weights = loadCalibrationWeights();
    expect(weights.blend).toEqual([0.5, 0.4, 0.1]);
  });

  it('reads an alternate path, so T53 has somewhere to write fitted values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'calibration-'));
    const path = join(dir, 'calibration.json');
    writeFileSync(path, JSON.stringify({ blend: [0.2, 0.3, 0.5] }));
    try {
      const weights = loadCalibrationWeights(path);
      expect(weights.blend).toEqual([0.2, 0.3, 0.5]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a malformed config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'calibration-'));
    const path = join(dir, 'calibration.json');
    writeFileSync(path, JSON.stringify({ blend: [0.5, 0.5] }));
    try {
      expect(() => loadCalibrationWeights(path)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
