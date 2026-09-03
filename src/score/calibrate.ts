import { notImplemented } from '../util/errors.js';
import type { Candidate } from '../candidates/types.js';

export interface CalibrationWeights {
  /** [voteFraction, rankScore, selfConfidence]; v1 ships [0.5, 0.4, 0.1]. */
  blend: [number, number, number];
}

export interface CalibrateOptions {
  mode: 'rank' | 'votes' | 'blend';
  samples: number;
  weights?: CalibrationWeights;
}

/**
 * T13. `rank` (the v1 default) is `score = 1 / (2 + rank)`. `votes` and
 * `blend` are M6 (T53). `clue_understood` is never a score.
 */
export function calibrate(
  _candidates: ReadonlyArray<Candidate>,
  _opts: CalibrateOptions,
): Candidate[] {
  return notImplemented('src/score/calibrate.ts');
}

/** Reads `config/calibration.json`. */
export function loadCalibrationWeights(_path?: string): CalibrationWeights {
  return notImplemented('src/score/calibrate.ts');
}
