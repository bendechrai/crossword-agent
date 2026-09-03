import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { aggregate, compare, type GroupAggregate } from '../../../src/eval/aggregate.js';
import type { RunRecord } from '../../../src/eval/types.js';

/**
 * Fixtures at test/fixtures/runs/aggregate/*.json (acceptance 1): two
 * profiles ("baseline", "patient") x three puzzles ("p1" american, "p2"
 * american, "p3" cryptic), plus four repeat fixtures ("rx"/"ry" x two
 * repeats each, "baseline" only) for the B1 variance-split test.
 */
function loadFixture(name: string): RunRecord {
  const url = new URL(`../../fixtures/runs/aggregate/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as RunRecord;
}

const baselineP1 = loadFixture('baseline-p1');
const baselineP2 = loadFixture('baseline-p2');
const baselineP3 = loadFixture('baseline-p3');
const patientP1 = loadFixture('patient-p1');
const patientP2 = loadFixture('patient-p2');
const patientP3 = loadFixture('patient-p3');

const baseSix = [baselineP1, baselineP2, baselineP3, patientP1, patientP2, patientP3];

const baselineRxR0 = loadFixture('baseline-rx-r0');
const baselineRxR1 = loadFixture('baseline-rx-r1');
const baselineRyR0 = loadFixture('baseline-ry-r0');
const baselineRyR1 = loadFixture('baseline-ry-r1');

function findGroup(groups: GroupAggregate[], name: string): GroupAggregate {
  const g = groups.find((group) => group.group === name);
  if (!g) throw new Error(`no group named ${name} in [${groups.map((x) => x.group).join(', ')}]`);
  return g;
}

describe('aggregate', () => {
  it('1. aggregates six hand-written fixtures to per-profile means (exact literals)', () => {
    const result = aggregate(baseSix, { by: 'profile' });
    expect(result.groups.map((g) => g.group).sort()).toEqual(['baseline', 'patient']);

    const baseline = findGroup(result.groups, 'baseline');
    expect(baseline.n).toBe(3);
    expect(baseline.letters.mean).toBeCloseTo(0.9, 10);
    expect(baseline.words.mean).toBeCloseTo(0.8, 10);
    expect(baseline.perfect.mean).toBeCloseTo(1 / 3, 10);
    expect(baseline.usdPerPuzzle).toBeCloseTo(0.1, 10);
    expect(baseline.usdPerCorrectWord).toBeCloseTo(0.075, 10);
    expect(baseline.tier2Share).toBeCloseTo(6 / 21, 10);
    expect(baseline.meanWallMs).toBe(1200);
    expect(baseline.budgetHits).toEqual({ usd: 1 });

    const patient = findGroup(result.groups, 'patient');
    expect(patient.n).toBe(3);
    expect(patient.letters.mean).toBeCloseTo(2.8 / 3, 10);
    expect(patient.words.mean).toBeCloseTo(2.6 / 3, 10);
    expect(patient.perfect.mean).toBeCloseTo(1 / 3, 10);
    expect(patient.usdPerPuzzle).toBeCloseTo(0.07, 10);
    expect(patient.usdPerCorrectWord).toBeCloseTo(0.0525, 10);
    expect(patient.tier2Share).toBeCloseTo(3 / 16, 10);
    expect(patient.meanWallMs).toBe(1000);
    expect(patient.budgetHits).toEqual({ tokens: 1 });
  });

  it('2. sample stdev (n-1) matches a hand-computed value; a one-record group reports null', () => {
    const result = aggregate(baseSix, { by: 'profile' });
    const baseline = findGroup(result.groups, 'baseline');
    // letters = [1.0, 0.9, 0.8]; mean 0.9; deviations +-0.1, 0; sum of
    // squares 0.02 / (3-1) = 0.01; sqrt = 0.1 exactly.
    expect(baseline.letters.stdev).toBeCloseTo(0.1, 10);

    const single = aggregate([baselineP1], { by: 'profile' });
    expect(single.groups).toHaveLength(1);
    expect(single.groups[0]?.n).toBe(1);
    expect(single.groups[0]?.letters.stdev).toBeNull();
    expect(single.groups[0]?.words.stdev).toBeNull();
    expect(single.groups[0]?.perfect.stdev).toBeNull();
  });

  it('3. usd per correct word is sum(usdCounterfactual)/sum(correct words), never usdBilled', () => {
    const result = aggregate(baseSix, { by: 'profile' });
    const baseline = findGroup(result.groups, 'baseline');
    // usd = 0.07 + 0.10 + 0.13 = 0.30; correct words = 2 + 1 + 1 = 4.
    expect(baseline.usdPerCorrectWord).toBeCloseTo(0.3 / 4, 10);

    // Editing usdBilled alone must not move the ratio (billed is never divided by anything).
    const billedEdited: RunRecord = {
      ...baselineP1,
      calls: {
        ...baselineP1.calls,
        tier1: { ...baselineP1.calls.tier1, usdBilled: baselineP1.calls.tier1.usdBilled + 5 },
      },
    };
    const withBilledEdit = aggregate([billedEdited, baselineP2, baselineP3], { by: 'profile' });
    expect(findGroup(withBilledEdit.groups, 'baseline').usdPerCorrectWord).toBeCloseTo(0.3 / 4, 10);

    // Editing usdCounterfactual alone must move the ratio.
    const counterfactualEdited: RunRecord = {
      ...baselineP1,
      calls: {
        ...baselineP1.calls,
        tier1: { ...baselineP1.calls.tier1, usdCounterfactual: baselineP1.calls.tier1.usdCounterfactual + 1 },
      },
    };
    const withCounterfactualEdit = aggregate([counterfactualEdited, baselineP2, baselineP3], { by: 'profile' });
    const editedRatio = findGroup(withCounterfactualEdit.groups, 'baseline').usdPerCorrectWord;
    expect(editedRatio).toBeCloseTo(1.3 / 4, 10);
    expect(editedRatio).not.toBeCloseTo(0.3 / 4, 5);
  });

  it('4. with repeat 2, within-puzzle and across-puzzle variance are separate fields and differ', () => {
    const result = aggregate([baselineRxR0, baselineRxR1, baselineRyR0, baselineRyR1], {
      by: 'profile',
      splitVariance: true,
    });
    const baseline = findGroup(result.groups, 'baseline');
    expect(baseline.variance).toBeDefined();
    // rx: [0.9, 0.7] -> sample variance 0.02; ry: [0.6, 0.6] -> sample variance 0.
    // withinPuzzle = mean(0.02, 0) = 0.01.
    expect(baseline.variance?.withinPuzzle).toBeCloseTo(0.01, 10);
    // puzzle means [0.8, 0.6] -> sample variance 0.02.
    expect(baseline.variance?.acrossPuzzle).toBeCloseTo(0.02, 10);
    expect(baseline.variance?.withinPuzzle).not.toBeCloseTo(baseline.variance?.acrossPuzzle ?? NaN, 5);

    const withoutSplit = aggregate([baselineRxR0, baselineRxR1, baselineRyR0, baselineRyR1], { by: 'profile' });
    expect(findGroup(withoutSplit.groups, 'baseline').variance).toBeUndefined();
  });

  it('5. --by stratum splits the fixtures into american and cryptic groups with the right membership', () => {
    const result = aggregate(baseSix, { by: 'stratum' });
    expect(result.groups.map((g) => g.group).sort()).toEqual(['american', 'cryptic']);

    const american = findGroup(result.groups, 'american');
    // p1 (both profiles) and p2 (both profiles) -> 4 records.
    expect(american.n).toBe(4);
    expect(american.letters.mean).toBeCloseTo((1.0 + 0.9 + 1.0 + 0.95) / 4, 10);

    const cryptic = findGroup(result.groups, 'cryptic');
    // p3 (both profiles) -> 2 records.
    expect(cryptic.n).toBe(2);
    expect(cryptic.letters.mean).toBeCloseTo((0.8 + 0.85) / 2, 10);
  });

  it('6. --by batchIndex groups per-slot rows and ignores rows with batchIndex: null', () => {
    const result = aggregate(baseSix, { by: 'batchIndex' });
    // Slot "3D" carries batchIndex: null in both baseline-p2 and patient-p2
    // and must not appear as its own group.
    expect(result.groups.map((g) => g.group).sort()).toEqual(['0', '1']);

    const zero = findGroup(result.groups, '0');
    expect(zero.n).toBe(6);
    expect(zero.words.mean).toBeCloseTo(4 / 6, 10);

    const one = findGroup(result.groups, '1');
    expect(one.n).toBe(4);
    expect(one.words.mean).toBeCloseTo(3 / 4, 10);
  });

  it('7. the difficulty view lists the clue both profiles got wrong first, then a clue one profile got wrong', () => {
    const result = aggregate(baseSix, { by: 'profile' });
    expect(result.slotDifficulty[0]).toMatchObject({
      puzzleId: 'p2',
      slotId: '1A',
      profilesWrong: 2,
      profilesTotal: 2,
    });
    // Exactly two clues with profilesWrong: 1, both after the both-wrong clue.
    const oneWrong = result.slotDifficulty.filter((row) => row.profilesWrong === 1);
    expect(oneWrong).toHaveLength(2);
    expect(oneWrong.map((r) => `${r.puzzleId}:${r.slotId}`).sort()).toEqual(['p2:3D', 'p3:4D']);
    expect(result.slotDifficulty.indexOf(oneWrong[0]!)).toBeGreaterThan(0);
  });

  it('8. compare(baseline, patient) produces a row per metric with the signed delta', () => {
    const result = aggregate(baseSix, { by: 'profile' });
    const baseline = findGroup(result.groups, 'baseline');
    const patient = findGroup(result.groups, 'patient');
    const rows = compare(baseline, patient);

    expect(rows.map((r) => r.metric)).toEqual([
      'letters',
      'words',
      'perfect',
      'usdPerPuzzle',
      'usdPerCorrectWord',
      'tier2Share',
      'meanWallMs',
    ]);
    for (const row of rows) {
      expect(row.delta).toBeCloseTo(row.b - row.a, 10);
    }

    const wallMsRow = rows.find((r) => r.metric === 'meanWallMs')!;
    expect(wallMsRow).toEqual({ metric: 'meanWallMs', a: 1200, b: 1000, delta: -200 });

    const usdPerPuzzleRow = rows.find((r) => r.metric === 'usdPerPuzzle')!;
    expect(usdPerPuzzleRow.a).toBeCloseTo(0.1, 10);
    expect(usdPerPuzzleRow.b).toBeCloseTo(0.07, 10);
    expect(usdPerPuzzleRow.delta).toBeCloseTo(-0.03, 10);
  });

  it('groups by puzzle across profiles', () => {
    const result = aggregate(baseSix, { by: 'puzzle' });
    expect(result.groups.map((g) => g.group).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(findGroup(result.groups, 'p1').n).toBe(2);
  });

  it('groups by producing tier at slot granularity', () => {
    const result = aggregate(baseSix, { by: 'tier' });
    const groupNames = result.groups.map((g) => g.group).sort();
    expect(groupNames).toEqual(['1', '2', 'wordlist']);
    // n across all groups equals the total number of perSlot entries (12).
    expect(result.groups.reduce((sum, g) => sum + g.n, 0)).toBe(12);
  });
});
