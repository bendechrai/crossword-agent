import type {
  CandidateRequest,
  CrossingContextEntry,
  PromptKind,
  Purpose,
  RejectedAnswer,
} from '../candidates/types.js';
import { usageError } from '../cli/exit.js';
import type { PuzzleStyle } from '../puzzle/types.js';
import type { LlmMessage } from './types.js';

/**
 * The prompt versions this module can render, oldest first.
 *
 * A version is a profile field (`profiles/schema.ts`) and a B23 cache-key field
 * (`candidates/service.ts` -> `util/hash.cacheKey`), and `candidates/service.ts`
 * picks the template by the resolved profile's value. Two versions of one
 * request are therefore two prompts and two cache entries, which is what makes
 * a paired A/B measurement possible: a bench run under `baseline` and one under
 * `baseline-pv2` differ in the prompt bytes and in nothing else.
 *
 * - "2" (T63) restates the exact letter count immediately before the answer
 *   field, adds a count-and-drop self-check (write each answer's letter count
 *   into "notes" and drop the ones that do not match), describes the
 *   `clue_understood` scale in words and varies the worked examples.
 * - "3" (T65) is "2" with the self-check removed and nothing else changed. The
 *   paired analysis in docs/benches/escalation-policy.md ("Decomposition of the
 *   drop") attributed about three quarters of a real slot-level regression - 103
 *   regressions against 67 gains over 612 slots, p about 0.006 - to that one
 *   instruction: under version 2 the model returned 35% fewer raw candidates and
 *   41% fewer completion tokens per call, and truth-in-candidates fell 11 points
 *   at length 3 and 9 points at length 4, which is 56% of all slots. The
 *   restated exact length and the confidence scale stay, because neither was
 *   implicated.
 *
 * Version "1" (T31) is no longer rendered: nothing selects it and T63's refresh
 * re-keyed its cache entries away.
 */
export const PROMPT_VERSIONS = ['2', '3'] as const;

export type PromptVersion = (typeof PROMPT_VERSIONS)[number];

/**
 * The default version: the `profiles/schema.ts` default and every built-in but
 * `baseline-pv2`, all of which import it rather than spell a version out (B49).
 *
 * It is the profile's copy of the value that reaches the cache key, `xw cache
 * clear --prompt-version` and the inference log, so a version that changed the
 * prompt bytes here while the profiles still carried the old one would leave
 * every cache key unchanged: a pre-existing cache would answer the new prompts
 * with the old version's responses, and every run record would mislabel the
 * version it ran. A bump therefore lands with the regenerated cache and
 * snapshots in one commit.
 */
export const PROMPT_VERSION: PromptVersion = '3';

/**
 * What `baseline-pv2` carries (T65): the previous version, kept selectable so
 * the self-prune can be measured as a paired difference on the same puzzles
 * rather than argued about. Nothing else in that profile differs from
 * `baseline`.
 */
export const PAIRED_PROMPT_VERSION: PromptVersion = '2';

export function isPromptVersion(value: string): value is PromptVersion {
  return (PROMPT_VERSIONS as readonly string[]).includes(value);
}

/**
 * A profile's `promptVersion` as a version this module can render.
 *
 * The schema types the field as a plain string (any profile file may set it),
 * so an unrenderable value has to fail somewhere. It fails here, as a usage
 * error naming the versions that exist, rather than silently rendering the
 * default template under a key that claims another version - which would put
 * one version's bytes behind another version's cache entries.
 */
export function promptVersionOf(value: string): PromptVersion {
  if (!isPromptVersion(value)) {
    throw usageError(
      `unknown promptVersion "${value}"`,
      `known prompt versions: ${PROMPT_VERSIONS.join(', ')}`,
    );
  }
  return value;
}

export interface RenderOptions {
  /** True when the model has no structured-output mode: inline the schema (B9). */
  inlineSchema: boolean;
  /** Which template renders: the resolved profile's `promptVersion` (B23). */
  version: PromptVersion;
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
 * What differs between the two rendered versions, and the whole of what differs.
 *
 * Version 3 is version 2 with the count-and-drop self-check removed: the
 * per-answer letter counts leave the system bullets, the ask line, the batched
 * length line and the worked examples, and every other byte - the restated exact
 * length, the `clue_understood` scale, the varied examples, the schemas, the
 * wording of every other rule - is what version 2 says. That is what lets the
 * paired measurement (`baseline` against `baseline-pv2`) attribute its
 * difference to the self-check and to nothing else.
 */
interface PromptExamples {
  certainRequest: string;
  certainAnswer: unknown;
  guessRequest: string;
  guessAnswer: unknown;
  batchedRequest: string;
  batchedAnswer: unknown;
}

interface PromptTemplate {
  version: PromptVersion;
  /** The system bullets on answer length, in order. */
  lengthRules: readonly string[];
  /** The last line of a single-clue prompt, read immediately before answering. */
  lengthLine: (slotId: string, length: number) => string;
  /** The same for the batched form, where each clue carries its own length. */
  batchedLengthLine: string;
  /** The escalate-only rule on doubting a crossing answer. */
  crossingSuspectRule: string;
  examples: PromptExamples;
}

/**
 * The exact letter count, restated as the last thing a single-clue prompt says
 * before the model answers (T63, kept by T65).
 *
 * The count is stated once in the `Length:` line and again here, because the
 * bench's dominant rejection reason by a distance was a wrong-length answer -
 * 85% of all candidate rejections, from a model that was told the length once,
 * sixteen lines earlier. The restatement is not what T65 removed: length
 * rejections fell from 85.5% to 65.4% of all rejections under version 2, and
 * the decomposition attributed the regression to the self-check that followed
 * this line, not to the line itself.
 */
function v3LengthLine(slotId: string, length: number): string {
  return `Every answer for ${slotId} is exactly ${pluralLetters(length)} long.`;
}

/** Version 2: the same restatement, with the count-and-drop self-check attached. */
function v2LengthLine(slotId: string, length: number): string {
  return (
    `Every answer for ${slotId} is exactly ${pluralLetters(length)} long: count each answer's ` +
    `letters into "notes" first, and put only the answers that come to ${length} into ` +
    '"candidates".'
  );
}

const V3_BATCHED_LENGTH_LINE =
  'Every answer is exactly as many letters as its own clue\'s "length" above.';

const V2_BATCHED_LENGTH_LINE =
  'Every answer is exactly as many letters as its own clue\'s "length" above: count each ' +
  'answer\'s letters into that result\'s "notes" first, and put only the answers that come to ' +
  'that clue\'s "length" into its "candidates".';

/** T31's rule, which version 2 replaced with the two self-check bullets below. */
const V3_LENGTH_RULES: readonly string[] = [
  '- Every answer has exactly the number of letters the clue asks for.',
];

const V2_LENGTH_RULES: readonly string[] = [
  '- Every answer has exactly the number of letters the clue asks for, and you check that before you commit to it. Write "clue_understood" first, then "notes" as one short line holding one ANSWER=count entry per answer you mean to offer, for example "HAVOC=5 RUINS=5 WRACK=5", and then "candidates" holding exactly those answers.',
  '- Every count you write equals the number of letters the clue asks for. When one does not, that answer is the wrong length: delete it from "notes" and never write it into "candidates". Three answers of the right length are worth more than ten of which seven are the wrong length.',
];

const V3_CROSSING_SUSPECT_RULE =
  '- If you believe a crossing answer is wrong, say so in "notes" as crossing_suspect: "<slotId>", for example crossing_suspect: "12A". Say which crossing you doubt rather than offering an answer that ignores the pattern.';

/** Version 2 puts the counts in "notes" first, so the suspect goes after them. */
const V2_CROSSING_SUSPECT_RULE =
  '- If you believe a crossing answer is wrong, say so in "notes" after the letter counts, as crossing_suspect: "<slotId>", for example crossing_suspect: "12A". Say which crossing you doubt rather than offering an answer that ignores the pattern.';

/**
 * Two worked examples, not one (T63, kept by T65). Version 1 shipped a single
 * example hard-coding `clue_understood: 0.9`, and 5,258 of the 5,279 parsed seed
 * responses on the canonical bench came back with exactly 0.9 - the model copied
 * the example rather than reporting anything. One example can only anchor one
 * point of the scale, so there are two: a clue whose answer is certain (1.0) and
 * a clue anyone can read whose answer is still a guess (0.5).
 *
 * The first is still the 5x5 fixture's 2D clue, so a reader of this file can
 * check it (T31's decision). The second is a short, deliberately ambiguous clue
 * that is NOT any slot in either synthetic fixture: a one-shot example
 * containing a fixture's own answer would leak that answer into every prompt the
 * fixture run sends, which is a measurement leak rather than a prompt
 * improvement.
 *
 * Under version 2 both examples also show the letter count in "notes", which is
 * where a count has to go: schemas/candidate-response.schema.json sets
 * `additionalProperties: false` on a candidate object, so a per-candidate count
 * field would be rejected by src/llm/parser.ts's ajv validation (and could not
 * be produced at all under tier 2's strict structured outputs). Version 3 shows
 * no counts anywhere, so no example demonstrates a self-check the instructions
 * no longer ask for.
 */
const EXAMPLE_TITLE = 'Example grid';

const CERTAIN_EXAMPLE_CANDIDATES = [
  { answer: 'HAVOC', confidence: 0.95 },
  { answer: 'RUINS', confidence: 0.3 },
  { answer: 'WRACK', confidence: 0.1 },
] as const;

const GUESS_EXAMPLE_CANDIDATES = [
  { answer: 'COST', confidence: 0.31 },
  { answer: 'RUSH', confidence: 0.22 },
  { answer: 'LOAD', confidence: 0.14 },
] as const;

const BATCHED_CERTAIN_CANDIDATES = [
  { answer: 'HAVOC', confidence: 0.95 },
  { answer: 'RUINS', confidence: 0.3 },
] as const;

const BATCHED_GUESS_CANDIDATES = [
  { answer: 'COST', confidence: 0.31 },
  { answer: 'RUSH', confidence: 0.22 },
] as const;

function exampleRequest(
  lengthLine: (slotId: string, length: number) => string,
  slotId: string,
  clue: string,
  length: number,
  n: number,
): string {
  return [
    `Puzzle: ${EXAMPLE_TITLE}`,
    `Style: american. ${STYLE_GUIDANCE.american}`,
    `Clue ${slotId}: ${clue}`,
    `Length: ${pluralLetters(length)} when run together.`,
    `Give up to ${n} candidate answers for ${slotId}, best first.`,
    lengthLine(slotId, length),
  ].join('\n');
}

function batchedExampleRequest(batchedLengthLine: string): string {
  return [
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
    batchedLengthLine,
  ].join('\n');
}

/**
 * `showCounts` writes "notes" before "candidates" on purpose: JSON property
 * order is free, and version 2's first refresh against the live model showed
 * the count is only a self-check if it is written BEFORE the answer list. Asked
 * for ten five-letter answers with the counts trailing, the model dutifully
 * wrote "MAYHEM=6 SCOURGE=7" and offered both anyway.
 */
function makeExamples(
  lengthLine: (slotId: string, length: number) => string,
  batchedLengthLine: string,
  showCounts: boolean,
): PromptExamples {
  return {
    certainRequest: exampleRequest(lengthLine, '2D', 'Chaos and destruction', 5, 3),
    certainAnswer: showCounts
      ? {
          clue_understood: 1,
          notes: 'HAVOC=5 RUINS=5 WRACK=5',
          candidates: CERTAIN_EXAMPLE_CANDIDATES,
        }
      : { clue_understood: 1, candidates: CERTAIN_EXAMPLE_CANDIDATES },
    guessRequest: exampleRequest(lengthLine, '5D', 'Charge', 4, 3),
    guessAnswer: showCounts
      ? {
          clue_understood: 0.5,
          notes: 'COST=4 RUSH=4 LOAD=4',
          candidates: GUESS_EXAMPLE_CANDIDATES,
        }
      : { clue_understood: 0.5, candidates: GUESS_EXAMPLE_CANDIDATES },
    batchedRequest: batchedExampleRequest(batchedLengthLine),
    batchedAnswer: {
      results: [
        showCounts
          ? {
              id: '2D',
              clue_understood: 1,
              notes: 'HAVOC=5 RUINS=5',
              candidates: BATCHED_CERTAIN_CANDIDATES,
            }
          : { id: '2D', clue_understood: 1, candidates: BATCHED_CERTAIN_CANDIDATES },
        showCounts
          ? {
              id: '5D',
              clue_understood: 0.5,
              notes: 'COST=4 RUSH=4',
              candidates: BATCHED_GUESS_CANDIDATES,
            }
          : { id: '5D', clue_understood: 0.5, candidates: BATCHED_GUESS_CANDIDATES },
      ],
    },
  };
}

const PROMPT_TEMPLATES: Readonly<Record<PromptVersion, PromptTemplate>> = {
  '2': {
    version: '2',
    lengthRules: V2_LENGTH_RULES,
    lengthLine: v2LengthLine,
    batchedLengthLine: V2_BATCHED_LENGTH_LINE,
    crossingSuspectRule: V2_CROSSING_SUSPECT_RULE,
    examples: makeExamples(v2LengthLine, V2_BATCHED_LENGTH_LINE, true),
  },
  '3': {
    version: '3',
    lengthRules: V3_LENGTH_RULES,
    lengthLine: v3LengthLine,
    batchedLengthLine: V3_BATCHED_LENGTH_LINE,
    crossingSuspectRule: V3_CROSSING_SUSPECT_RULE,
    examples: makeExamples(v3LengthLine, V3_BATCHED_LENGTH_LINE, false),
  },
};

/** The template one version renders. Exported so a test can compare two. */
export function templateFor(version: PromptVersion): PromptTemplate {
  return PROMPT_TEMPLATES[version];
}

/** What a single-clue prompt asks for, last: how many answers, then their length. */
function askLines(template: PromptTemplate, slotId: string, length: number, n: number): string[] {
  return [
    `Give up to ${n} candidate answers for ${slotId}, best first.`,
    template.lengthLine(slotId, length),
  ];
}

interface SystemOptions {
  kind: PromptKind;
  batched: boolean;
  inlineSchema: boolean;
  template: PromptTemplate;
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
    ...opts.template.lengthRules,
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
      opts.template.crossingSuspectRule,
    );
  }

  if (!opts.inlineSchema) return lines.join('\n');

  const examples = opts.template.examples;
  lines.push(
    '',
    SCHEMA_HEADING,
    '',
    json(opts.batched ? BATCHED_RESPONSE_SCHEMA : SINGLE_RESPONSE_SCHEMA),
    '',
    EXAMPLE_HEADING,
    '',
    opts.batched ? examples.batchedRequest : examples.certainRequest,
    '',
    EXAMPLE_ANSWER_HEADING,
    '',
    // The example ends with the JSON object and nothing after it, because the
    // parser takes the LAST balanced object in the reply (B41): a model that
    // copies the shape of this example ends its own reply the same way.
    json(opts.batched ? examples.batchedAnswer : examples.certainAnswer),
  );
  // The batched example already shows both ends of the clue_understood scale
  // in its two results; the single form needs a second exchange to do the same
  // (T63).
  if (!opts.batched) {
    lines.push(
      '',
      SECOND_EXAMPLE_HEADING,
      '',
      examples.guessRequest,
      '',
      EXAMPLE_ANSWER_HEADING,
      '',
      json(examples.guessAnswer),
    );
  }
  return lines.join('\n');
}

function renderClueBlock(
  req: CandidateRequest,
  kind: PromptKind,
  template: PromptTemplate,
): string {
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

  lines.push(...askLines(template, req.slotId, req.length, req.n));
  return lines.join('\n');
}

/**
 * T31: one clue. `constrained` is rendered for both re-ask and repair.
 *
 * `opts.version` selects the template (T65). The caller passes the resolved
 * profile's `promptVersion`, which is also the value the cache key carries, so
 * one version's bytes can never sit behind another version's key.
 */
export function renderPrompt(
  req: CandidateRequest,
  kind: PromptKind,
  opts: RenderOptions,
): RenderedPrompt {
  const template = templateFor(opts.version);
  return {
    promptKind: kind,
    messages: [
      {
        role: 'system',
        content: renderSystem({ kind, batched: false, inlineSchema: opts.inlineSchema, template }),
      },
      { role: 'user', content: renderClueBlock(req, kind, template) },
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

  const template = templateFor(opts.version);
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
    template.batchedLengthLine,
  );

  return {
    promptKind: 'seed',
    messages: [
      {
        role: 'system',
        content: renderSystem({
          kind: 'seed',
          batched: true,
          inlineSchema: opts.inlineSchema,
          template,
        }),
      },
      { role: 'user', content: lines.join('\n') },
    ],
  };
}
