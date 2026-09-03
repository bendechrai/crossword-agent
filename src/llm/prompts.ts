import type {
  CandidateRequest,
  CrossingContextEntry,
  PromptKind,
  Purpose,
  RejectedAnswer,
} from '../candidates/types.js';
import type { PuzzleStyle } from '../puzzle/types.js';
import type { LlmMessage } from './types.js';

/**
 * Frozen at "1" for all of v1. T31 is the single owner of this constant, and a
 * bump lands with the regenerated cache and snapshots in one commit (B49).
 */
export const PROMPT_VERSION = '1';

export interface RenderOptions {
  /** True when the model has no structured-output mode: inline the schema (B9). */
  inlineSchema: boolean;
}

export interface RenderedPrompt {
  promptKind: PromptKind;
  messages: LlmMessage[];
}

/**
 * Which of the three templates a purpose renders (B23). Re-ask and repair both
 * render `constrained`, so a repair call reuses a re-ask's cache entry when
 * every prompt-visible field matches; smoke and calibrate are plain seeding.
 */
export function promptKindFor(purpose: Purpose): PromptKind {
  switch (purpose) {
    case 'reask':
    case 'repair':
      return 'constrained';
    case 'escalate':
      return 'escalate';
    case 'seed':
    case 'smoke':
    case 'calibrate':
      return 'seed';
  }
}

/**
 * The candidate entry, shared by both response branches.
 *
 * The inlined schemas below are the `#/$defs/single` and `#/$defs/batched`
 * branches of schemas/candidate-response.schema.json with every `$ref`
 * resolved, because a model cannot follow a `$ref` into a document it was
 * never sent. A test deep-equals both against the schema file, so the copy
 * here cannot drift from the contract the parser validates against.
 *
 * They are literals rather than a file read because these templates are pure
 * string builders with no I/O and no clock, which is what makes the golden
 * files stable.
 */
const CANDIDATE_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string', minLength: 1 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['answer', 'confidence'],
  additionalProperties: false,
} as const;

const SINGLE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    clue_understood: { type: 'number', minimum: 0, maximum: 1 },
    candidates: { type: 'array', items: CANDIDATE_SCHEMA },
    notes: { type: 'string' },
  },
  required: ['clue_understood', 'candidates'],
  additionalProperties: false,
} as const;

const BATCHED_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1 },
          clue_understood: { type: 'number', minimum: 0, maximum: 1 },
          candidates: { type: 'array', items: CANDIDATE_SCHEMA },
          notes: { type: 'string' },
        },
        required: ['id', 'clue_understood', 'candidates'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const;

/** Headings the golden-file test locates the inlined blocks by. */
const SCHEMA_HEADING = 'Reply with JSON matching this JSON Schema:';
const EXAMPLE_HEADING = 'Worked example. Given this request:';
const EXAMPLE_ANSWER_HEADING = 'reply with exactly this and nothing else:';

const STYLE_GUIDANCE: Record<PuzzleStyle, string> = {
  american:
    'American-style crossword: the clue is a definition or a light play on words, abbreviations and proper nouns are common, and the answer may be a phrase.',
  cryptic:
    'Cryptic crossword: the clue has a definition at one end and wordplay for the rest (anagram, charade, hidden word, homophone, container, reversal or deletion), and the enumeration gives the printed word lengths of the answer.',
  quick: 'Quick crossword: the clue is a short definition or a single synonym.',
  unknown:
    'Crossword of unknown style: read the clue as a definition first, and try a wordplay reading only if the definition reading gives nothing.',
};

/**
 * Sorted exactly as `cacheKeyFields` sorts it (B23), so two requests that share
 * a cache key also share the prompt bytes. Rendering the caller's order instead
 * would let one cache entry stand for two different prompts.
 */
function sortedRejected(rejected: ReadonlyArray<RejectedAnswer>): RejectedAnswer[] {
  return [...rejected].sort((a, b) =>
    a.answer === b.answer ? compare(a.reason, b.reason) : compare(a.answer, b.answer),
  );
}

/** Sorted by slot id, for the same reason `sortedRejected` is sorted. */
function sortedCrossings(
  entries: ReadonlyArray<CrossingContextEntry> | undefined,
): CrossingContextEntry[] {
  return [...(entries ?? [])].sort((a, b) => compare(a.slotId, b.slotId));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Two decimals, so a float that differs far down cannot move a golden file. */
function confidenceText(confidence: number): string {
  return confidence.toFixed(2);
}

function pluralLetters(length: number): string {
  return length === 1 ? '1 letter' : `${length} letters`;
}

/**
 * The worked example is the 5x5 fixture's 2D clue, so it is a real clue with a
 * real answer that a reader of this file can check.
 */
const SINGLE_EXAMPLE_REQUEST = [
  'Puzzle: Synthetic five',
  `Style: american. ${STYLE_GUIDANCE.american}`,
  'Clue 2D: Chaos and destruction',
  'Length: 5 letters when run together.',
  'Give up to 3 candidate answers for 2D, best first.',
].join('\n');

const SINGLE_EXAMPLE_ANSWER = {
  clue_understood: 0.9,
  candidates: [
    { answer: 'HAVOC', confidence: 0.82 },
    { answer: 'RUINS', confidence: 0.34 },
    { answer: 'WRACK', confidence: 0.11 },
  ],
} as const;

const BATCHED_EXAMPLE_REQUEST = [
  'Puzzle: Synthetic five',
  `Style: american. ${STYLE_GUIDANCE.american}`,
  'Answer every clue below. Give up to 3 candidate answers per clue, best first, and carry each clue\'s "id" back into its result.',
  '',
  json({
    clues: [
      { id: '2D', clue: 'Chaos and destruction', length: 5, pattern: '?????', style: 'american' },
      { id: '9A', clue: 'Former partner', length: 2, pattern: '??', style: 'american' },
    ],
  }),
].join('\n');

const BATCHED_EXAMPLE_ANSWER = {
  results: [
    {
      id: '2D',
      clue_understood: 0.9,
      candidates: [
        { answer: 'HAVOC', confidence: 0.82 },
        { answer: 'RUINS', confidence: 0.34 },
      ],
    },
    {
      id: '9A',
      clue_understood: 0.7,
      candidates: [{ answer: 'EX', confidence: 0.66 }],
    },
  ],
} as const;

interface SystemOptions {
  kind: PromptKind;
  batched: boolean;
  inlineSchema: boolean;
}

function renderSystem(opts: SystemOptions): string {
  const lines: string[] = [
    'You are an expert crossword solver. You reply with JSON and nothing else.',
    '',
    'How to answer:',
  ];

  lines.push(
    opts.batched
      ? '- Reply with a single JSON object of the form { "results": [ ... ] } holding one result per clue. No prose before it, no prose after it, no code fences.'
      : '- Reply with a single JSON object. No prose before it, no prose after it, no code fences.',
  );
  if (opts.batched) {
    lines.push(
      '- Every result carries back the "id" of the clue it answers, spelled exactly as the request spells it. Return one result for every id you were given, even when its "candidates" array is empty.',
    );
  }
  lines.push(
    '- "clue_understood" is a number from 0 to 1 saying how sure you are that you have read the clue correctly. It is a routing signal, not a score for any answer.',
    '- "candidates" is an array ordered best first. Each entry is an object with an "answer" and a "confidence" from 0 to 1.',
    '- "notes" is optional and at most one short line.',
    '- Answers are written the way they are entered in the grid: run together in uppercase A-Z, with no spaces, no hyphens, no apostrophes, no punctuation and no accents. "Button your lip" is entered as BUTTONYOURLIP.',
    '- Every answer has exactly the number of letters the clue asks for.',
    '- Offer each answer once. Two spellings that run together to the same letters are the same answer.',
  );

  if (opts.batched || opts.kind === 'constrained' || opts.kind === 'escalate') {
    lines.push(
      '- The pattern shows the letters already fixed by crossing answers: every letter shown is certain, and "?" is a letter that is not yet known.',
      '- Every answer matches the pattern letter for letter in the positions the pattern fixes.',
    );
  }
  if (opts.kind === 'constrained' || opts.kind === 'escalate') {
    lines.push(
      '- Answers already rejected for this clue are listed with the reason each was dropped. Do not offer any of them again.',
    );
  }
  if (opts.kind === 'escalate') {
    lines.push(
      "- The answers crossing this clue are listed with the solver's confidence in each. They are working guesses and any of them may be wrong.",
      '- If you believe a crossing answer is wrong, say so in "notes" as crossing_suspect: "<slotId>", for example crossing_suspect: "12A". Say which crossing you doubt rather than offering an answer that ignores the pattern.',
    );
  }

  if (!opts.inlineSchema) return lines.join('\n');

  lines.push(
    '',
    SCHEMA_HEADING,
    '',
    json(opts.batched ? BATCHED_RESPONSE_SCHEMA : SINGLE_RESPONSE_SCHEMA),
    '',
    EXAMPLE_HEADING,
    '',
    opts.batched ? BATCHED_EXAMPLE_REQUEST : SINGLE_EXAMPLE_REQUEST,
    '',
    EXAMPLE_ANSWER_HEADING,
    '',
    // The example ends with the JSON object and nothing after it, because the
    // parser takes the LAST balanced object in the reply (B41): a model that
    // copies the shape of this example ends its own reply the same way.
    json(opts.batched ? BATCHED_EXAMPLE_ANSWER : SINGLE_EXAMPLE_ANSWER),
  );
  return lines.join('\n');
}

function renderClueBlock(req: CandidateRequest, kind: PromptKind): string {
  const lines: string[] = [];
  if (req.title !== undefined) lines.push(`Puzzle: ${req.title}`);
  lines.push(`Style: ${req.style}. ${STYLE_GUIDANCE[req.style]}`);
  lines.push(`Clue ${req.slotId}: ${req.clue}`);
  // Verbatim (B21): T7 may append a trailing word to the parenthesised group,
  // as in "(3,4) hyphenated", and the model should see whatever the clue said.
  if (req.enumeration !== undefined) {
    lines.push(
      `Enumeration: ${req.enumeration}. That is how the answer is printed; it is still entered run together.`,
    );
  }
  lines.push(`Length: ${pluralLetters(req.length)} when run together.`);

  if (kind === 'constrained' || kind === 'escalate') {
    lines.push(
      `Known letters: ${req.pattern}`,
      'In that pattern every letter shown is already certain and "?" is a letter that is not yet known.',
    );
    const rejected = sortedRejected(req.rejected);
    if (rejected.length > 0) {
      lines.push('Already rejected for this clue:');
      for (const entry of rejected) lines.push(`- ${entry.answer}: ${entry.reason}`);
    } else {
      lines.push('Nothing has been rejected for this clue yet.');
    }
  }

  if (kind === 'escalate') {
    const crossings = sortedCrossings(req.crossingContext);
    if (crossings.length > 0) {
      lines.push('Answers crossing this clue, as the solver currently has them:');
      for (const entry of crossings) {
        const fill =
          entry.fill === null
            ? 'not yet filled'
            : `${entry.fill} (confidence ${confidenceText(entry.confidence)})`;
        lines.push(`- ${entry.slotId} "${entry.clue}": ${fill}`);
      }
    } else {
      lines.push('No crossing answers are recorded for this clue.');
    }
  }

  lines.push(`Give up to ${req.n} candidate answers for ${req.slotId}, best first.`);
  return lines.join('\n');
}

/** T31: one clue. `constrained` is rendered for both re-ask and repair. */
export function renderPrompt(
  req: CandidateRequest,
  kind: PromptKind,
  opts: RenderOptions,
): RenderedPrompt {
  return {
    promptKind: kind,
    messages: [
      {
        role: 'system',
        content: renderSystem({ kind, batched: false, inlineSchema: opts.inlineSchema }),
      },
      { role: 'user', content: renderClueBlock(req, kind) },
    ],
  };
}

/**
 * The puzzle title every request in the batch agrees on, or undefined when they
 * disagree or carry none. A batch is one puzzle's seed pass, so they agree.
 */
function commonTitle(reqs: ReadonlyArray<CandidateRequest>): string | undefined {
  const first = reqs[0]?.title;
  return reqs.every((req) => req.title === first) ? first : undefined;
}

/** Every style in the batch, deduplicated and ordered, so the render is stable. */
function batchStyles(reqs: ReadonlyArray<CandidateRequest>): PuzzleStyle[] {
  return [...new Set(reqs.map((req) => req.style))].sort(compare);
}

/** The batched seed form (B3): `{ clues: [...] }` in, `{ results: [...] }` back. */
export function renderBatchedSeedPrompt(
  reqs: ReadonlyArray<CandidateRequest>,
  opts: RenderOptions,
): RenderedPrompt {
  if (reqs.length === 0) {
    throw new Error('renderBatchedSeedPrompt: a batch needs at least one request');
  }
  // B3: batching is a seed-pass optimisation only. A batched re-ask would mix
  // slots whose patterns are changing under each other mid-search.
  const offender = reqs.find((req) => req.purpose !== 'seed');
  if (offender !== undefined) {
    throw new Error(
      `renderBatchedSeedPrompt: batching applies to purpose "seed" only (B3), got "${offender.purpose}" for ${offender.slotId}`,
    );
  }

  const n = Math.max(...reqs.map((req) => req.n));
  const title = commonTitle(reqs);
  const lines: string[] = [];
  if (title !== undefined) lines.push(`Puzzle: ${title}`);
  for (const style of batchStyles(reqs)) lines.push(`Style: ${style}. ${STYLE_GUIDANCE[style]}`);
  lines.push(
    `Answer every clue below. Give up to ${n} candidate answers per clue, best first, and carry each clue's "id" back into its result.`,
    '',
    json({
      clues: reqs.map((req) => ({
        id: req.slotId,
        clue: req.clue,
        length: req.length,
        pattern: req.pattern,
        style: req.style,
        ...(req.enumeration === undefined ? {} : { enumeration: req.enumeration }),
      })),
    }),
  );

  return {
    promptKind: 'seed',
    messages: [
      {
        role: 'system',
        content: renderSystem({ kind: 'seed', batched: true, inlineSchema: opts.inlineSchema }),
      },
      { role: 'user', content: lines.join('\n') },
    ],
  };
}
