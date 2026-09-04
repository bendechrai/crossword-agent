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
 * Single owner of the prompt version (B49): a bump lands with the regenerated
 * cache and snapshots in one commit, and no feature task may bump it.
 *
 * "2" (T63) differs from "1" (T31) in exactly two measured ways:
 *
 * - Length discipline. 85% of all candidate rejections on the canonical bench
 *   were wrong-length answers, and the M2 spike measured 66.8% of all returned
 *   candidates and 13.5% of top candidates at the wrong length
 *   (docs/spikes/tier1-reliability.md section 5). Version 2 restates the exact
 *   letter count as the last line before the model answers, and asks for a
 *   per-answer letter count plus a drop-the-mismatches self-check.
 * - `clue_understood`. Every parsed seed response on that bench reported 0.9
 *   (5,258 of 5,279), because version 1's one-shot examples hard-coded
 *   0.9/0.9/0.7, so the escalation trigger at 0.4 could never fire. Version 2
 *   describes the scale in words and shows two worked examples, one at 1.0 and
 *   one at 0.5.
 */
export const PROMPT_VERSION = '2';

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
/** T63: the second example, the one that is not certain of its answer. */
const SECOND_EXAMPLE_HEADING =
  'Second worked example, a clue that is easy to read but hard to answer. Given this request:';

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
 * The last thing a single-clue prompt says before the model answers (T63).
 *
 * The exact letter count is stated once in the `Length:` line and again here,
 * because the bench's dominant rejection reason by a distance is a
 * wrong-length answer: 85% of all candidate rejections, from a model that was
 * told the length once, sixteen lines earlier. The self-check is the second
 * half of the same fix - a model that has to write "HAVOC=5" next to its
 * answer has to look at the answer again before it commits to it.
 */
function askLines(slotId: string, length: number, n: number): string[] {
  return [
    `Give up to ${n} candidate answers for ${slotId}, best first.`,
    `Every answer for ${slotId} is exactly ${pluralLetters(length)} long: count each answer's ` +
      `letters into "notes" first, and put only the answers that come to ${length} into ` +
      '"candidates".',
  ];
}

/** The same reminder for the batched form, where each clue carries its own length. */
const BATCHED_LENGTH_LINE =
  'Every answer is exactly as many letters as its own clue\'s "length" above: count each ' +
  'answer\'s letters into that result\'s "notes" first, and put only the answers that come to ' +
  'that clue\'s "length" into its "candidates".';

/**
 * Two worked examples, not one (T63). Version 1 shipped a single example
 * hard-coding `clue_understood: 0.9`, and 5,258 of the 5,279 parsed seed
 * responses on the canonical bench came back with exactly 0.9 - the model
 * copied the example rather than reporting anything. One example can only
 * anchor one point of the scale, so there are now two: a clue whose answer is
 * certain (1.0) and a clue anyone can read whose answer is still a guess
 * (0.5).
 *
 * The first is still the 5x5 fixture's 2D clue, so a reader of this file can
 * check it (T31's decision). The second is a short, deliberately ambiguous
 * clue that is NOT any slot in either synthetic fixture: a one-shot example
 * containing a fixture's own answer would leak that answer into every prompt
 * the fixture run sends, which is a measurement leak rather than a prompt
 * improvement.
 *
 * Both show the letter count in "notes", which is where it has to go:
 * schemas/candidate-response.schema.json sets `additionalProperties: false` on
 * a candidate object, so a per-candidate count field would be rejected by
 * src/llm/parser.ts's ajv validation (and cannot be produced at all under tier
 * 2's strict structured outputs). "notes" is the one free-form field the
 * schema already allows.
 */
const EXAMPLE_TITLE = 'Example grid';

function exampleRequest(slotId: string, clue: string, length: number, n: number): string {
  return [
    `Puzzle: ${EXAMPLE_TITLE}`,
    `Style: american. ${STYLE_GUIDANCE.american}`,
    `Clue ${slotId}: ${clue}`,
    `Length: ${pluralLetters(length)} when run together.`,
    ...askLines(slotId, length, n),
  ].join('\n');
}

const CERTAIN_EXAMPLE_REQUEST = exampleRequest('2D', 'Chaos and destruction', 5, 3);

const CERTAIN_EXAMPLE_ANSWER = {
  clue_understood: 1,
  // "notes" before "candidates" on purpose: JSON property order is free, and
  // the first refresh against the live model showed the count is only a
  // self-check if it is written BEFORE the answer list. Asked for ten
  // five-letter answers with the counts trailing, the model dutifully wrote
  // "MAYHEM=6 SCOURGE=7" and offered both anyway.
  notes: 'HAVOC=5 RUINS=5 WRACK=5',
  candidates: [
    { answer: 'HAVOC', confidence: 0.95 },
    { answer: 'RUINS', confidence: 0.3 },
    { answer: 'WRACK', confidence: 0.1 },
  ],
} as const;

const GUESS_EXAMPLE_REQUEST = exampleRequest('5D', 'Charge', 4, 3);

const GUESS_EXAMPLE_ANSWER = {
  clue_understood: 0.5,
  notes: 'COST=4 RUSH=4 LOAD=4',
  candidates: [
    { answer: 'COST', confidence: 0.31 },
    { answer: 'RUSH', confidence: 0.22 },
    { answer: 'LOAD', confidence: 0.14 },
  ],
} as const;

const BATCHED_EXAMPLE_REQUEST = [
  `Puzzle: ${EXAMPLE_TITLE}`,
  `Style: american. ${STYLE_GUIDANCE.american}`,
  'Answer every clue below. Give up to 3 candidate answers per clue, best first, and carry each clue\'s "id" back into its result.',
  '',
  json({
    clues: [
      { id: '2D', clue: 'Chaos and destruction', length: 5, pattern: '?????', style: 'american' },
      { id: '5D', clue: 'Charge', length: 4, pattern: '????', style: 'american' },
    ],
  }),
  '',
  BATCHED_LENGTH_LINE,
].join('\n');

const BATCHED_EXAMPLE_ANSWER = {
  results: [
    {
      id: '2D',
      clue_understood: 1,
      notes: 'HAVOC=5 RUINS=5',
      candidates: [
        { answer: 'HAVOC', confidence: 0.95 },
        { answer: 'RUINS', confidence: 0.3 },
      ],
    },
    {
      id: '5D',
      clue_understood: 0.5,
      notes: 'COST=4 RUSH=4',
      candidates: [
        { answer: 'COST', confidence: 0.31 },
        { answer: 'RUSH', confidence: 0.22 },
      ],
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
    '- "clue_understood" is a number from 0 to 1 saying how sure you are that you have read the clue correctly. It is a routing signal, not a score for any answer, and the solver acts on the number you report.',
    '- Choose it on this scale: 1.0 only when the clue is unambiguous and your best answer is certain; around 0.5 when you understand what the clue is asking but the answer is a guess; below 0.3 when the clue itself is opaque to you and you are offering something anyway. Everything in between is in use, and the same number on every clue tells the solver nothing.',
    '- "candidates" is an array ordered best first. Each entry is an object with an "answer" and a "confidence" from 0 to 1; an entry missing either of those two fields makes the whole reply unusable.',
    '- Answers are written the way they are entered in the grid: run together in uppercase A-Z, with no spaces, no hyphens, no apostrophes, no punctuation and no accents. "Button your lip" is entered as BUTTONYOURLIP.',
    '- Every answer has exactly the number of letters the clue asks for, and you check that before you commit to it. Write "clue_understood" first, then "notes" as one short line holding one ANSWER=count entry per answer you mean to offer, for example "HAVOC=5 RUINS=5 WRACK=5", and then "candidates" holding exactly those answers.',
    '- Every count you write equals the number of letters the clue asks for. When one does not, that answer is the wrong length: delete it from "notes" and never write it into "candidates". Three answers of the right length are worth more than ten of which seven are the wrong length.',
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
      '- If you believe a crossing answer is wrong, say so in "notes" after the letter counts, as crossing_suspect: "<slotId>", for example crossing_suspect: "12A". Say which crossing you doubt rather than offering an answer that ignores the pattern.',
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
    opts.batched ? BATCHED_EXAMPLE_REQUEST : CERTAIN_EXAMPLE_REQUEST,
    '',
    EXAMPLE_ANSWER_HEADING,
    '',
    // The example ends with the JSON object and nothing after it, because the
    // parser takes the LAST balanced object in the reply (B41): a model that
    // copies the shape of this example ends its own reply the same way.
    json(opts.batched ? BATCHED_EXAMPLE_ANSWER : CERTAIN_EXAMPLE_ANSWER),
  );
  // The batched example already shows both ends of the clue_understood scale
  // in its two results; the single form needs a second exchange to do the same
  // (T63).
  if (!opts.batched) {
    lines.push(
      '',
      SECOND_EXAMPLE_HEADING,
      '',
      GUESS_EXAMPLE_REQUEST,
      '',
      EXAMPLE_ANSWER_HEADING,
      '',
      json(GUESS_EXAMPLE_ANSWER),
    );
  }
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

  lines.push(...askLines(req.slotId, req.length, req.n));
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
    // Last, so the length rule is the final thing read before the reply (T63).
    '',
    BATCHED_LENGTH_LINE,
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
