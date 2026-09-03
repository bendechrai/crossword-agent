import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from '../util/fs.js';
import { NotImplementedError } from '../util/errors.js';
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
 * T13. `rank` (the v1 default) is `score = 1 / (2 + rank)`, the 0-based
 * position in the model's list preserved through validation. `votes` and
 * `blend` are M6 (T53): a mis-set profile fails loudly rather than silently
 * falling back to `rank`. `clue_understood` is never a score, only a routing
 * signal (spec), so it never appears here.
 */
export function calibrate(
  candidates: ReadonlyArray<Candidate>,
  opts: CalibrateOptions,
): Candidate[] {
  if (opts.mode === 'votes' || opts.mode === 'blend') {
    throw new NotImplementedError(
      `src/score/calibrate.ts: '${opts.mode}' calibration is M6 (T53); only 'rank' is implemented in v1`,
    );
  }
  return candidates.map((c) => ({ ...c, score: 1 / (2 + c.rank) }));
}

function defaultCalibrationPath(): string {
  return join(repoRoot(), 'config', 'calibration.json');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Reads `config/calibration.json` (or a substitute path), validating that it
 * carries exactly three finite `blend` weights. This is a loader only - it
 * does not check that the weights sum to 1, since the fitted values T53
 * writes here need not (v1's placeholder `[0.5, 0.4, 0.1]` does, but that is
 * a property of the shipped file, not an invariant this loader enforces).
 */
export function loadCalibrationWeights(path: string = defaultCalibrationPath()): CalibrationWeights {
  const text = readFileSync(path, 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !Array.isArray(parsed.blend)) {
    throw new Error(`malformed calibration config at ${path}: expected a { blend: [w1, w2, w3] } object`);
  }
  const blend: unknown[] = parsed.blend as unknown[];
  if (blend.length !== 3 || !blend.every(isFiniteNumber)) {
    throw new Error(`malformed calibration config at ${path}: "blend" must be exactly 3 finite numbers`);
  }
  const w1 = blend[0];
  const w2 = blend[1];
  const w3 = blend[2];
  if (w1 === undefined || w2 === undefined || w3 === undefined) {
    throw new Error(`malformed calibration config at ${path}: "blend" must be exactly 3 finite numbers`);
  }
  return { blend: [w1, w2, w3] };
}
