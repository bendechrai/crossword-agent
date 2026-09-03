import type { Candidate, RejectedAnswer, Tier } from '../candidates/types.js';
import type { CandidateReject, ValidationResult } from './types.js';

export interface ValidateInput {
  /** Raw answers as the model returned them, in model order. */
  raw: ReadonlyArray<{ answer: string; confidence: number }>;
  length: number;
  pattern: string;
  clue: string;
  tier: Tier;
  fromCache: boolean;
  /** The slot's persistent rejection set. */
  rejected: ReadonlyArray<RejectedAnswer>;
  /** Clue-echo rejection is waived when the slot would otherwise be empty. */
  allowEchoWhenEmpty?: boolean;
}

export interface ValidateCandidatesResult extends ValidationResult {
  /**
   * True when every surviving candidate was a clue echo and
   * `allowEchoWhenEmpty` let them through anyway, so the caller can emit the
   * waiver alongside its `candidate:reject` events.
   */
  echoWaived: boolean;
}

// Strip Unicode punctuation (P*: dashes, apostrophes/quotes, general
// punctuation) and separators (Z*: spaces of every kind).
const STRIP_RE = /[\p{P}\p{Z}]/gu;
// Combining marks left behind by NFD decomposition of accented letters.
const COMBINING_RE = /\p{Mn}/gu;
const CHARSET_RE = /^[A-Z]+$/;

/**
 * Uppercase; strip spaces, hyphens, apostrophes and punctuation;
 * NFD-decompose and drop combining marks. Anything that survives and is not
 * `A-Z` is left in place for the caller's charset check (B: ligatures and
 * sharp-s are out of scope for v1 and fall out as `charset` rejects).
 */
export function normaliseAnswer(raw: string): string {
  const stripped = raw.toUpperCase().replace(STRIP_RE, '');
  return stripped.normalize('NFD').replace(COMBINING_RE, '');
}

// `grid/pattern.ts` (T5) owns the shared pattern-regex builder, but it is an
// unimplemented stub within this task's own wave (both T5 and T6 depend only
// on T0), so building the regex there and calling into it here would throw
// NotImplementedError at test time. This is a tiny, self-contained
// duplicate of the same `? -> [A-Z]`, anchored construction described in the
// spec; see the deviations note in the PR for the follow-up once T5 lands.
const patternRegexCache = new Map<string, RegExp>();

function regexForPattern(pattern: string): RegExp {
  const cached = patternRegexCache.get(pattern);
  if (cached !== undefined) return cached;
  const body = pattern
    .split('')
    .map((ch) => (ch === '?' ? '[A-Z]' : ch))
    .join('');
  const re = new RegExp(`^${body}$`);
  patternRegexCache.set(pattern, re);
  return re;
}

/**
 * Dedupe entries by `answer`, keeping the one with the higher `score` and
 * summing `votes` across every entry sharing that answer. Ties (equal
 * score) keep whichever entry was seen first. Returns survivors in
 * first-seen order plus the entries that lost the dedupe.
 */
function dedupeByAnswer<T extends { answer: string; votes: number; score: number }>(
  entries: ReadonlyArray<T>,
): { survivors: T[]; dropped: T[] } {
  const order: string[] = [];
  const byAnswer = new Map<string, T>();
  const dropped: T[] = [];

  for (const entry of entries) {
    const existing = byAnswer.get(entry.answer);
    if (existing === undefined) {
      byAnswer.set(entry.answer, entry);
      order.push(entry.answer);
      continue;
    }
    const votes = existing.votes + entry.votes;
    if (entry.score > existing.score) {
      dropped.push(existing);
      byAnswer.set(entry.answer, { ...entry, votes });
    } else {
      dropped.push(entry);
      byAnswer.set(entry.answer, { ...existing, votes });
    }
  }

  const survivors = order.map((answer) => {
    const merged = byAnswer.get(answer);
    if (merged === undefined) {
      throw new Error(`unreachable: missing dedupe entry for ${answer}`);
    }
    return merged;
  });
  return { survivors, dropped };
}

interface WorkingCandidate {
  answer: string;
  raw: string;
  rank: number;
  selfConfidence: number;
  votes: number;
  score: number;
}

/**
 * T6: the chain in exactly this order - normalise, charset, length, pattern,
 * dedupe, clue-echo, persistent rejection set. Every drop carries a
 * `RejectReason`. Pure: no events, no clock.
 */
export function validateCandidates(input: ValidateInput): ValidateCandidatesResult {
  const rejects: CandidateReject[] = [];
  const filtered: WorkingCandidate[] = [];

  input.raw.forEach((r, rank) => {
    const answer = normaliseAnswer(r.answer);
    if (!CHARSET_RE.test(answer)) {
      rejects.push({ answer, raw: r.answer, reason: 'charset' });
      return;
    }
    if (answer.length !== input.length) {
      rejects.push({ answer, raw: r.answer, reason: 'length' });
      return;
    }
    if (!regexForPattern(input.pattern).test(answer)) {
      rejects.push({ answer, raw: r.answer, reason: 'pattern' });
      return;
    }
    filtered.push({
      answer,
      raw: r.answer,
      rank,
      selfConfidence: r.confidence,
      votes: 1,
      score: r.confidence,
    });
  });

  const { survivors: deduped, dropped } = dedupeByAnswer(filtered);
  for (const d of dropped) rejects.push({ answer: d.answer, raw: d.raw, reason: 'duplicate' });

  const clueNorm = normaliseAnswer(input.clue);
  const tagged = deduped.map((candidate) => ({
    candidate,
    isEcho: clueNorm.includes(candidate.answer),
  }));
  const nonEcho = tagged.filter((t) => !t.isEcho).map((t) => t.candidate);

  let afterEcho: WorkingCandidate[];
  let echoWaived = false;
  if (nonEcho.length > 0) {
    for (const t of tagged) {
      if (t.isEcho) {
        rejects.push({ answer: t.candidate.answer, raw: t.candidate.raw, reason: 'clue-echo' });
      }
    }
    afterEcho = nonEcho;
  } else if (deduped.length > 0 && input.allowEchoWhenEmpty === true) {
    // Every survivor is a clue echo, and rejecting them all would leave the
    // slot empty: waive the rule, and let the caller know it happened.
    afterEcho = deduped;
    echoWaived = true;
  } else {
    for (const t of tagged) {
      rejects.push({ answer: t.candidate.answer, raw: t.candidate.raw, reason: 'clue-echo' });
    }
    afterEcho = [];
  }

  const rejectedBefore = new Set(input.rejected.map((r) => normaliseAnswer(r.answer)));
  const accepted: Candidate[] = [];
  for (const c of afterEcho) {
    if (rejectedBefore.has(c.answer)) {
      rejects.push({ answer: c.answer, raw: c.raw, reason: 'rejected-before' });
      continue;
    }
    accepted.push({
      answer: c.answer,
      raw: c.raw,
      rank: c.rank,
      selfConfidence: c.selfConfidence,
      votes: c.votes,
      score: c.score,
      tier: input.tier,
      fromCache: input.fromCache,
    });
  }

  return { accepted, rejects, echoWaived };
}

/** Convenience for callers that already hold `Candidate` objects. */
export function dedupeCandidates(candidates: ReadonlyArray<Candidate>): Candidate[] {
  return dedupeByAnswer(candidates).survivors;
}
