import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openCandidateCache } from '../../../src/candidates/cache.js';
import { createCandidateService } from '../../../src/candidates/service.js';
import type { CandidateRequest } from '../../../src/candidates/types.js';
import { isCliError } from '../../../src/cli/exit.js';
import {
  PAIRED_PROMPT_VERSION,
  PROMPT_VERSION,
  PROMPT_VERSIONS,
  isPromptVersion,
  promptKindFor,
  promptVersionOf,
  renderBatchedSeedPrompt,
  renderPrompt,
  templateFor,
  type PromptVersion,
  type RenderOptions,
  type RenderedPrompt,
} from '../../../src/llm/prompts.js';
import { resetRegistryForTests } from '../../../src/llm/rateLimiter.js';
import type { InferenceLog, InferenceLogRecord } from '../../../src/llm/types.js';
import { getBuiltins } from '../../../src/profiles/builtins.js';
import { ProfileObject, ProfileSchema } from '../../../src/profiles/schema.js';
import { singleBody, stubTransport } from '../../helpers/stubTransport.js';

const GOLDEN_DIR = fileURLToPath(new URL('../../fixtures/prompts/', import.meta.url));
const SCHEMA_PATH = fileURLToPath(
  new URL('../../../schemas/candidate-response.schema.json', import.meta.url),
);
const PROMPTS_SOURCE = fileURLToPath(new URL('../../../src/llm/prompts.ts', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../../../src/', import.meta.url));

/** Every `.ts` file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/**
 * Golden files are committed and compared byte for byte, one directory per
 * rendered version (`test/fixtures/prompts/v2/`, `v3/`). Regenerate them with
 * `UPDATE_GOLDENS=1` in the same commit as any deliberate wording change, which
 * for a shipped promptVersion also means regenerating the cache (B49).
 *
 * The v2 files are frozen: version 2 stays selectable so the length self-check
 * can be measured as a paired difference (T65), and a version whose bytes moved
 * under it would measure nothing. A diff under `v2/` after a golden refresh is
 * a bug, not an update.
 */
function assertGolden(version: PromptVersion, name: string, rendered: RenderedPrompt): string {
  const text = serialise(rendered);
  const dir = `${GOLDEN_DIR}v${version}/`;
  const path = `${dir}${name}`;
  if (process.env['UPDATE_GOLDENS'] === '1') {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, text, 'utf8');
  }
  expect(readFileSync(path, 'utf8')).toBe(text);
  return text;
}

function serialise(rendered: RenderedPrompt): string {
  const parts = [`promptKind: ${rendered.promptKind}`];
  for (const message of rendered.messages) parts.push(`--- ${message.role} ---`, message.content);
  return `${parts.join('\n')}\n`;
}

function flatten(rendered: RenderedPrompt): string {
  return rendered.messages.map((message) => message.content).join('\n');
}

function userText(rendered: RenderedPrompt): string {
  const user = rendered.messages.find((message) => message.role === 'user');
  expect(user).toBeDefined();
  return user?.content ?? '';
}

function systemText(rendered: RenderedPrompt): string {
  const system = rendered.messages.find((message) => message.role === 'system');
  expect(system).toBeDefined();
  return system?.content ?? '';
}

const BASE: CandidateRequest = {
  slotId: '1A',
  clue: 'Ribbon knot',
  length: 3,
  pattern: '???',
  style: 'american',
  title: 'Synthetic seven',
  rejected: [],
  tier: 1,
  purpose: 'seed',
  n: 10,
  samples: 1,
  sampleIndex: 0,
};

function request(overrides: Partial<CandidateRequest>): CandidateRequest {
  return { ...BASE, ...overrides };
}

/** The 7x7 fixture's 9A: a real clue whose enumeration is part of the text. */
const SEED_REQUEST = request({
  slotId: '9A',
  clue: 'US city on the Hudson (3,4)',
  length: 7,
  pattern: '???????',
  enumeration: '(3,4)',
});

/** Three clues from the 7x7 fixture, the batch the seed pass would send. */
const BATCH_REQUESTS: CandidateRequest[] = [
  request({ slotId: '1A', clue: 'Ribbon knot', length: 3, pattern: '???' }),
  request({ slotId: '4A', clue: 'Drink brewed from leaves', length: 3, pattern: '???' }),
  SEED_REQUEST,
];

/** The spec's worked pattern, A?I?N, with the rejections given out of order. */
const REASK_REQUEST: CandidateRequest = {
  slotId: '12A',
  clue: 'Being from another planet',
  length: 5,
  pattern: 'A?I?N',
  style: 'american',
  rejected: [
    { answer: 'AVIAN', reason: 'no candidate at 5D agreed on the crossing letter' },
    { answer: 'ANIMAL', reason: 'wrong length' },
  ],
  tier: 1,
  purpose: 'reask',
  n: 10,
  samples: 1,
  sampleIndex: 0,
};

/** The repair pass asking for something other than the answer it already has. */
const REPAIR_REQUEST = request({
  slotId: '5A',
  clue: 'Artificial silk made from cellulose',
  length: 5,
  pattern: 'R?Y?N',
  title: 'Synthetic five',
  rejected: [{ answer: 'RAYON', reason: 'the repair pass is looking for a different answer' }],
  tier: 2,
  purpose: 'repair',
  n: 5,
});

/** 6D of the 5x5 fixture, crossed by 5A, 7A and 8A; crossings given out of order. */
const ESCALATE_REQUEST = request({
  slotId: '6D',
  clue: 'The person being addressed',
  length: 3,
  pattern: 'Y?U',
  title: 'Synthetic five',
  rejected: [{ answer: 'THY', reason: 'clue echo' }],
  tier: 2,
  purpose: 'escalate',
  n: 8,
  crossingContext: [
    { slotId: '8A', clue: 'Small parasitic insect', fill: 'LOUSE', confidence: 0.41 },
    { slotId: '5A', clue: 'Artificial silk made from cellulose', fill: 'RAYON', confidence: 0.62 },
    { slotId: '7A', clue: 'Steer clear of', fill: null, confidence: 0 },
  ],
});

function plain(version: PromptVersion = PROMPT_VERSION): RenderOptions {
  return { inlineSchema: false, version };
}

function inline(version: PromptVersion = PROMPT_VERSION): RenderOptions {
  return { inlineSchema: true, version };
}

/** The default version (3), which is what every unversioned assertion below is about. */
const PLAIN = plain();
const INLINE = inline();
const PLAIN_V2 = plain('2');
const INLINE_V2 = inline('2');

describe('PROMPT_VERSION (T65)', () => {
  // B49: moving this is a single-owner action that lands the regenerated cache
  // and snapshots in the same commit. It is a bare digit, never "v3". T63
  // bumped it from "1" to "2" for the length self-check and the reworded
  // clue_understood scale; T65 moved it to "3", which is "2" without the
  // self-check.
  it('is the string "3", and "2" is still renderable for the paired measurement', () => {
    expect(PROMPT_VERSION).toBe('3');
    expect(PAIRED_PROMPT_VERSION).toBe('2');
    expect(PROMPT_VERSIONS).toEqual(['2', '3']);
  });

  it('recognises the versions it renders and no others', () => {
    expect(isPromptVersion('2')).toBe(true);
    expect(isPromptVersion('3')).toBe(true);
    expect(isPromptVersion('1')).toBe(false);
    expect(isPromptVersion('v3')).toBe(false);
    for (const version of PROMPT_VERSIONS) expect(promptVersionOf(version)).toBe(version);
  });

  // A profile file may set any string. Rendering the default template under a
  // key that claims another version would put one version's bytes behind
  // another version's cache entries, so an unknown value is a usage error.
  it('rejects a version it cannot render, as a usage error naming the known ones', () => {
    let thrown: unknown;
    try {
      promptVersionOf('1');
    } catch (e) {
      thrown = e;
    }
    expect(isCliError(thrown)).toBe(true);
    expect(String((thrown as Error).message)).toContain('1');
  });

  // The version is only real if it reaches the B23 cache key, which is built
  // from `profile.promptVersion` (candidates/service.ts -> util/hash.cacheKey),
  // and the inference log's copy in llm/client.ts. A default left behind would
  // leave every key unchanged, so a pre-existing cache would answer version-3
  // prompts with version-2 responses and `xw cache clear --prompt-version`
  // would target the wrong entries. So no other module may spell a version out.
  it('is what every built-in but baseline-pv3 carries, and the schema default', () => {
    const profiles = Object.values(getBuiltins());
    // The count pin that keeps this loop from passing over an empty set lives
    // with the name list, in test/unit/profiles/builtins.test.ts.
    for (const profile of profiles) {
      expect(profile.promptVersion).toBe(
        profile.name === 'baseline-pv3' ? PROMPT_VERSION : PAIRED_PROMPT_VERSION,
      );
    }
    expect(ProfileSchema.parse({ name: 'x' }).promptVersion).toBe(PAIRED_PROMPT_VERSION);
  });

  it('is the only place in src/ a prompt version literal is written', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      if (file === PROMPTS_SOURCE) continue;
      const text = readFileSync(file, 'utf8');
      // `promptVersion: '1'`, `promptVersion = "2"`, `.default('1')` and so on.
      // `baseline-pv2` is no exception: it carries `PAIRED_PROMPT_VERSION`.
      if (/promptVersion\s*[:=]\s*['"][0-9]+['"]|PROMPT_VERSION\s*=\s*['"][0-9]+['"]/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('promptKindFor (B23: three templates, six purposes)', () => {
  it('renders constrained for both re-ask and repair', () => {
    expect(promptKindFor('reask')).toBe('constrained');
    expect(promptKindFor('repair')).toBe('constrained');
  });

  it('renders seed for seeding, smoke and calibration, and escalate for escalation', () => {
    expect(promptKindFor('seed')).toBe('seed');
    expect(promptKindFor('smoke')).toBe('seed');
    expect(promptKindFor('calibrate')).toBe('seed');
    expect(promptKindFor('escalate')).toBe('escalate');
  });
});

describe.each(PROMPT_VERSIONS)('golden files, version %s (acceptance 1)', (version) => {
  const flat = plain(version);
  const withSchema = inline(version);

  it('seed-single', () => {
    assertGolden(version, 'seed-single.txt', renderPrompt(SEED_REQUEST, 'seed', flat));
  });

  it('seed-batched-3', () => {
    assertGolden(version, 'seed-batched-3.txt', renderBatchedSeedPrompt(BATCH_REQUESTS, flat));
  });

  // Re-ask and repair render the same template (B23), so these two goldens
  // differ only in their inputs. That is the point: the same prompt bytes mean
  // the same cache entry whichever pass asked for them.
  it('constrained-reask', () => {
    assertGolden(version, 'constrained-reask.txt', renderPrompt(REASK_REQUEST, 'constrained', flat));
  });

  it('constrained-repair', () => {
    assertGolden(
      version,
      'constrained-repair.txt',
      renderPrompt(REPAIR_REQUEST, 'constrained', flat),
    );
  });

  it('escalate', () => {
    assertGolden(version, 'escalate.txt', renderPrompt(ESCALATE_REQUEST, 'escalate', flat));
  });

  it('seed-inline-schema', () => {
    assertGolden(version, 'seed-inline-schema.txt', renderPrompt(SEED_REQUEST, 'seed', withSchema));
  });
});

describe('seed template (acceptance 2)', () => {
  const rendered = renderPrompt(SEED_REQUEST, 'seed', PLAIN);

  it('carries the clue text verbatim, trailing enumeration included', () => {
    expect(userText(rendered)).toContain('Clue 9A: US city on the Hudson (3,4)');
    expect(userText(rendered)).toContain('Enumeration: (3,4)');
  });

  it('states that answers are uppercase with no spaces', () => {
    expect(systemText(rendered)).toContain('uppercase');
    expect(systemText(rendered)).toContain('no spaces');
  });

  it('gives the length, the style and the number of answers wanted', () => {
    expect(userText(rendered)).toContain('Length: 7 letters');
    expect(userText(rendered)).toContain('Style: american.');
    expect(userText(rendered)).toContain('Give up to 10 candidate answers for 9A, best first.');
  });

  it('renders the puzzle title, and omits the line when there is none', () => {
    expect(userText(rendered)).toContain('Puzzle: Synthetic seven');
    const untitled = renderPrompt(request({ title: undefined }), 'seed', PLAIN);
    expect(userText(untitled)).not.toContain('Puzzle:');
  });

  it('omits the enumeration line when the slot has none, and never shows the pattern', () => {
    const text = userText(renderPrompt(request({}), 'seed', PLAIN));
    expect(text).not.toContain('Enumeration:');
    expect(text).not.toContain('Known letters:');
  });

  it('renders a multi-word enumeration with its trailing word verbatim (T7 may append one)', () => {
    const text = userText(
      renderPrompt(request({ enumeration: '(3,4) hyphenated', length: 7 }), 'seed', PLAIN),
    );
    expect(text).toContain('Enumeration: (3,4) hyphenated.');
  });

  it('describes each puzzle style it is given', () => {
    expect(userText(renderPrompt(request({ style: 'cryptic' }), 'seed', PLAIN))).toContain(
      'Style: cryptic. Cryptic crossword:',
    );
    expect(userText(renderPrompt(request({ style: 'quick' }), 'seed', PLAIN))).toContain(
      'Style: quick. Quick crossword:',
    );
    expect(userText(renderPrompt(request({ style: 'unknown' }), 'seed', PLAIN))).toContain(
      'Style: unknown. Crossword of unknown style:',
    );
  });

  it('says "1 letter" rather than "1 letters" for a one-cell slot', () => {
    const text = userText(renderPrompt(request({ length: 1, pattern: '?' }), 'seed', PLAIN));
    expect(text).toContain('Length: 1 letter when run together.');
  });
});

describe('constrained template (acceptance 3)', () => {
  const rendered = renderPrompt(REASK_REQUEST, 'constrained', PLAIN);

  it('carries the pattern and a line saying what "?" means', () => {
    expect(userText(rendered)).toContain('Known letters: A?I?N');
    expect(userText(rendered)).toContain(
      'In that pattern every letter shown is already certain and "?" is a letter that is not yet known.',
    );
  });

  it('lists every rejected answer with its reason, one line each', () => {
    expect(userText(rendered)).toContain('- ANIMAL: wrong length');
    expect(userText(rendered)).toContain(
      '- AVIAN: no candidate at 5D agreed on the crossing letter',
    );
  });

  it('orders the rejected list the way the cache key sorts it, not the caller order', () => {
    const text = userText(rendered);
    expect(text.indexOf('- ANIMAL')).toBeLessThan(text.indexOf('- AVIAN'));
  });

  it('says so plainly when nothing has been rejected yet', () => {
    const text = userText(renderPrompt(request({ pattern: 'R?Y?N' }), 'constrained', PLAIN));
    expect(text).toContain('Nothing has been rejected for this clue yet.');
  });

  it('reports the same promptKind for a re-ask and for a repair', () => {
    expect(renderPrompt(REASK_REQUEST, 'constrained', PLAIN).promptKind).toBe('constrained');
    expect(renderPrompt(REPAIR_REQUEST, 'constrained', PLAIN).promptKind).toBe('constrained');
  });
});

describe('escalate template (acceptance 4)', () => {
  const rendered = renderPrompt(ESCALATE_REQUEST, 'escalate', PLAIN);

  it("carries every crossing slot's clue and current fill", () => {
    const text = userText(rendered);
    expect(text).toContain('- 5A "Artificial silk made from cellulose": RAYON (confidence 0.62)');
    expect(text).toContain('- 7A "Steer clear of": not yet filled');
    expect(text).toContain('- 8A "Small parasitic insect": LOUSE (confidence 0.41)');
  });

  it('orders the crossings by slot id, the way the cache key normalises them', () => {
    const text = userText(rendered);
    expect(text.indexOf('- 5A')).toBeLessThan(text.indexOf('- 7A'));
    expect(text.indexOf('- 7A')).toBeLessThan(text.indexOf('- 8A'));
  });

  it('permits crossing_suspect in notes', () => {
    expect(systemText(rendered)).toContain('crossing_suspect');
    expect(systemText(rendered)).toContain('crossing_suspect: "<slotId>"');
  });

  it('keeps the constrained material as well', () => {
    expect(userText(rendered)).toContain('Known letters: Y?U');
    expect(userText(rendered)).toContain('- THY: clue echo');
  });

  it('says so rather than throwing when a slot has no crossings recorded', () => {
    const text = userText(
      renderPrompt(request({ purpose: 'escalate', crossingContext: [] }), 'escalate', PLAIN),
    );
    expect(text).toContain('No crossing answers are recorded for this clue.');
  });
});

describe('batched seed form (acceptance 5)', () => {
  const rendered = renderBatchedSeedPrompt(BATCH_REQUESTS, PLAIN);

  it("carries every clue's id, clue text, length, pattern and style", () => {
    const payload = jsonAfter(userText(rendered), 'Answer every clue below') as {
      clues: Array<Record<string, unknown>>;
    };
    expect(payload.clues).toEqual([
      { id: '1A', clue: 'Ribbon knot', length: 3, pattern: '???', style: 'american' },
      { id: '4A', clue: 'Drink brewed from leaves', length: 3, pattern: '???', style: 'american' },
      {
        id: '9A',
        clue: 'US city on the Hudson (3,4)',
        length: 7,
        pattern: '???????',
        style: 'american',
        enumeration: '(3,4)',
      },
    ]);
  });

  it('asks for results keyed by the same ids', () => {
    expect(systemText(rendered)).toContain('{ "results": [ ... ] }');
    expect(systemText(rendered)).toContain(
      'Every result carries back the "id" of the clue it answers',
    );
  });

  it('throws when asked to batch a re-ask (B3: seeding only)', () => {
    const reask = request({ purpose: 'reask' });
    expect(() => renderBatchedSeedPrompt([...BATCH_REQUESTS, reask], PLAIN)).toThrow(
      /purpose "seed" only/,
    );
  });

  it('throws on an empty batch', () => {
    expect(() => renderBatchedSeedPrompt([], PLAIN)).toThrow(/at least one request/);
  });

  it('renders the shared puzzle title once, and drops it when the batch disagrees', () => {
    expect(userText(rendered)).toContain('Puzzle: Synthetic seven');
    const mixed = renderBatchedSeedPrompt(
      [BATCH_REQUESTS[0] as CandidateRequest, request({ slotId: '4A', title: 'Another puzzle' })],
      PLAIN,
    );
    expect(userText(mixed)).not.toContain('Puzzle:');
  });

  it('describes each distinct style in the batch once', () => {
    const mixed = renderBatchedSeedPrompt(
      [BATCH_REQUESTS[0] as CandidateRequest, request({ slotId: '4A', style: 'cryptic' })],
      PLAIN,
    );
    const text = userText(mixed);
    expect(text).toContain('Style: american.');
    expect(text).toContain('Style: cryptic.');
    expect(text.match(/^Style: american\./gm)).toHaveLength(1);
  });

  it('asks for the largest n in the batch', () => {
    const mixed = renderBatchedSeedPrompt(
      [request({ n: 4 }), request({ slotId: '4A', n: 12 })],
      PLAIN,
    );
    expect(userText(mixed)).toContain('Give up to 12 candidate answers per clue');
  });
});

/**
 * The blocks are printed with two-space indentation, so a block's closing brace
 * is the first `}` that starts a line after the heading.
 */
function jsonAfter(text: string, heading: string): unknown {
  const headingAt = text.indexOf(heading);
  expect(headingAt).toBeGreaterThanOrEqual(0);
  const open = text.indexOf('{', headingAt);
  const close = text.indexOf('\n}', open);
  expect(close).toBeGreaterThan(open);
  return JSON.parse(text.slice(open, close + 2)) as unknown;
}

interface SchemaFile {
  $defs: Record<string, unknown>;
}

const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as SchemaFile;

/** A model cannot follow a `$ref` into a document it was never sent. */
function resolveRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(resolveRefs);
  if (typeof node !== 'object' || node === null) return node;
  const record = node as Record<string, unknown>;
  const ref = record['$ref'];
  if (typeof ref === 'string') return resolveRefs(SCHEMA.$defs[ref.replace('#/$defs/', '')]);
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, resolveRefs(value)]),
  );
}

describe('inline schema variant (acceptance 7, B9)', () => {
  const rendered = renderPrompt(SEED_REQUEST, 'seed', INLINE);

  it("inlines the schema file's single-response branch, refs resolved", () => {
    const inlined = jsonAfter(systemText(rendered), 'Reply with JSON matching this JSON Schema:');
    expect(inlined).toEqual(resolveRefs(SCHEMA.$defs['single']));
  });

  it("inlines the batched branch for a batched request, refs resolved", () => {
    const batched = renderBatchedSeedPrompt(BATCH_REQUESTS, INLINE);
    const inlined = jsonAfter(systemText(batched), 'Reply with JSON matching this JSON Schema:');
    expect(inlined).toEqual(resolveRefs(SCHEMA.$defs['batched']));
  });

  it("uses the 5x5 fixture's 2D clue as the one-shot example, and answers it", () => {
    const system = systemText(rendered);
    expect(system).toContain('Clue 2D: Chaos and destruction');
    const example = jsonAfter(system, 'reply with exactly this and nothing else:') as {
      candidates: Array<{ answer: string }>;
    };
    expect(example.candidates[0]?.answer).toBe('HAVOC');
  });

  it('ends the example, and the message, with the JSON object (the parser takes the last one)', () => {
    expect(systemText(rendered).trimEnd().endsWith('}')).toBe(true);
  });

  it('adds nothing to the system message when the model has structured outputs', () => {
    const plain = systemText(renderPrompt(SEED_REQUEST, 'seed', PLAIN));
    expect(plain).not.toContain('JSON Schema');
    expect(plain).not.toContain('Worked example');
    expect(systemText(rendered).startsWith(plain)).toBe(true);
  });
});

/** The line every version-3 single-clue template ends on: slot id and exact count. */
function lastAskLine(slotId: string, length: number): string {
  return `Every answer for ${slotId} is exactly ${length} letters long.`;
}

/** The same line under version 2, which appends the count-and-drop self-check. */
function lastAskLineV2(slotId: string, length: number): string {
  return (
    `Every answer for ${slotId} is exactly ${length} letters long: count each answer's letters ` +
    `into "notes" first, and put only the answers that come to ${length} into "candidates".`
  );
}

/** The self-check sentences version 3 drops, in the words version 2 used. */
const SELF_CHECK_PHRASES = [
  'Write "clue_understood" first, then "notes" as one short line holding one ANSWER=count entry per answer you mean to offer',
  'delete it from "notes" and never write it into "candidates"',
  'and you check that before you commit to it',
  'count each answer',
];

/**
 * T65 acceptance 1. Version 3 keeps the restated exact length as the last line
 * before the answer - length rejections did fall under version 2, from 85.5% to
 * 65.4% of all rejections - and drops the count-and-drop self-check that
 * followed it, which the paired decomposition in
 * docs/benches/escalation-policy.md holds responsible for about three quarters
 * of a real slot-level regression (35% fewer raw candidates and 41% fewer
 * completion tokens per call, with short answers losing recall).
 */
describe('length discipline, version 3 (T65, acceptance 1)', () => {
  const singles: ReadonlyArray<{ kind: string; rendered: RenderedPrompt; last: string }> = [
    {
      kind: 'seed',
      rendered: renderPrompt(SEED_REQUEST, 'seed', PLAIN),
      last: lastAskLine('9A', 7),
    },
    {
      kind: 'constrained',
      rendered: renderPrompt(REASK_REQUEST, 'constrained', PLAIN),
      last: lastAskLine('12A', 5),
    },
    {
      kind: 'escalate',
      rendered: renderPrompt(ESCALATE_REQUEST, 'escalate', PLAIN),
      last: lastAskLine('6D', 3),
    },
  ];

  for (const { kind, rendered, last } of singles) {
    it(`${kind}: restates the exact letter count as the last line before the answer`, () => {
      const lines = userText(rendered).split('\n');
      expect(lines[lines.length - 1]).toBe(last);
    });

    it(`${kind}: keeps a plain length rule and no self-check anywhere`, () => {
      const system = systemText(rendered);
      expect(system).toContain('- Every answer has exactly the number of letters the clue asks for.');
      for (const phrase of SELF_CHECK_PHRASES) expect(flatten(rendered)).not.toContain(phrase);
      expect(flatten(rendered)).not.toContain('ANSWER=count');
    });
  }

  it('says "1 letter" rather than "1 letters" in the restatement too', () => {
    const text = userText(renderPrompt(request({ length: 1, pattern: '?' }), 'seed', PLAIN));
    expect(text.endsWith('is exactly 1 letter long.')).toBe(true);
  });

  it("ends the batched user message with the same rule, keyed to each clue's length", () => {
    const lines = userText(renderBatchedSeedPrompt(BATCH_REQUESTS, PLAIN)).split('\n');
    expect(lines[lines.length - 1]).toBe(
      'Every answer is exactly as many letters as its own clue\'s "length" above.',
    );
  });

  it('shows no per-candidate counts in any one-shot example', () => {
    for (const system of [
      systemText(renderPrompt(SEED_REQUEST, 'seed', INLINE)),
      systemText(renderBatchedSeedPrompt(BATCH_REQUESTS, INLINE)),
      systemText(renderPrompt(ESCALATE_REQUEST, 'escalate', INLINE)),
    ]) {
      expect(system).not.toMatch(/"notes": "[A-Z]+=\d/);
      expect(system).not.toContain('HAVOC=5');
    }
  });

  it('sends the crossing_suspect rule without the letter-count clause', () => {
    const system = systemText(renderPrompt(ESCALATE_REQUEST, 'escalate', PLAIN));
    expect(system).toContain('say so in "notes" as crossing_suspect: "<slotId>"');
    expect(system).not.toContain('after the letter counts');
  });
});

/**
 * T63 acceptance 1, kept as the frozen description of what version 2 says: the
 * paired measurement is only worth running while `baseline-pv2` still renders
 * exactly the prompt the regression was measured on.
 */
describe('length discipline, version 2 (T63, unchanged)', () => {
  const singles: ReadonlyArray<{ kind: string; rendered: RenderedPrompt; last: string }> = [
    {
      kind: 'seed',
      rendered: renderPrompt(SEED_REQUEST, 'seed', PLAIN_V2),
      last: lastAskLineV2('9A', 7),
    },
    {
      kind: 'constrained',
      rendered: renderPrompt(REASK_REQUEST, 'constrained', PLAIN_V2),
      last: lastAskLineV2('12A', 5),
    },
    {
      kind: 'escalate',
      rendered: renderPrompt(ESCALATE_REQUEST, 'escalate', PLAIN_V2),
      last: lastAskLineV2('6D', 3),
    },
  ];

  for (const { kind, rendered, last } of singles) {
    it(`${kind}: restates the exact letter count and the self-check as the last line`, () => {
      const lines = userText(rendered).split('\n');
      expect(lines[lines.length - 1]).toBe(last);
    });

    it(`${kind}: carries the count-and-drop self-check in the system message`, () => {
      const system = systemText(rendered);
      expect(system).toContain(
        'Write "clue_understood" first, then "notes" as one short line holding one ANSWER=count ' +
          'entry per answer you mean to offer',
      );
      expect(system).toContain('delete it from "notes" and never write it into "candidates"');
      expect(system).toContain(
        'Every answer has exactly the number of letters the clue asks for, and you check that ' +
          'before you commit to it',
      );
    });
  }

  it("ends the batched user message with version 2's rule", () => {
    const lines = userText(renderBatchedSeedPrompt(BATCH_REQUESTS, PLAIN_V2)).split('\n');
    expect(lines[lines.length - 1]).toBe(
      'Every answer is exactly as many letters as its own clue\'s "length" above: count each ' +
        'answer\'s letters into that result\'s "notes" first, and put only the answers that come ' +
        'to that clue\'s "length" into its "candidates".',
    );
  });

  it('shows the counts in every one-shot example, and the counts are right', () => {
    for (const system of [
      systemText(renderPrompt(SEED_REQUEST, 'seed', INLINE_V2)),
      systemText(renderBatchedSeedPrompt(BATCH_REQUESTS, INLINE_V2)),
    ]) {
      const notes = [...system.matchAll(/"notes": "([^"]+)"/g)].map((match) => match[1] ?? '');
      expect(notes.length).toBeGreaterThanOrEqual(2);
      for (const note of notes) {
        for (const pair of note.split(' ')) {
          const [answer, count] = pair.split('=');
          expect(answer?.length).toBe(Number(count));
        }
      }
    }
  });

  it('keeps every example answer at the length its own example request asked for', () => {
    const system = systemText(renderPrompt(SEED_REQUEST, 'seed', INLINE_V2));
    // "Clue 2D: ..." is asked at 5 letters, "Clue 5D: Charge" at 4.
    expect(system).toContain('Clue 2D: Chaos and destruction');
    expect(system).toContain('Clue 5D: Charge');
    expect(system).toContain(lastAskLineV2('2D', 5));
    expect(system).toContain(lastAskLineV2('5D', 4));
  });
});

/**
 * The two versions differ in the self-check and in nothing else (T65 decision).
 * Asserted as a diff rather than as prose: every line version 2 renders that
 * version 3 does not, and the reverse, has to be one of the length lines.
 */
describe('version 3 is version 2 minus the self-prune', () => {
  const cases: ReadonlyArray<[string, RenderedPrompt, RenderedPrompt]> = [
    [
      'seed',
      renderPrompt(SEED_REQUEST, 'seed', INLINE_V2),
      renderPrompt(SEED_REQUEST, 'seed', INLINE),
    ],
    [
      'constrained',
      renderPrompt(REASK_REQUEST, 'constrained', INLINE_V2),
      renderPrompt(REASK_REQUEST, 'constrained', INLINE),
    ],
    [
      'escalate',
      renderPrompt(ESCALATE_REQUEST, 'escalate', INLINE_V2),
      renderPrompt(ESCALATE_REQUEST, 'escalate', INLINE),
    ],
    [
      'batched seed',
      renderBatchedSeedPrompt(BATCH_REQUESTS, INLINE_V2),
      renderBatchedSeedPrompt(BATCH_REQUESTS, INLINE),
    ],
  ];

  /** Lines about answer length or the counts in "notes": the whole of the delta. */
  function aboutLength(line: string): boolean {
    return (
      /letters?|length|count|ANSWER=|=\d|notes/i.test(line) ||
      line.trim() === '' ||
      line.trim() === '},' ||
      line.trim() === '}'
    );
  }

  for (const [name, v2, v3] of cases) {
    it(`${name}: every line that differs is a length line`, () => {
      const before = new Set(flatten(v2).split('\n'));
      const after = new Set(flatten(v3).split('\n'));
      const removed = [...before].filter((line) => !after.has(line));
      const added = [...after].filter((line) => !before.has(line));
      expect(removed.length).toBeGreaterThan(0);
      for (const line of [...removed, ...added]) expect(aboutLength(line)).toBe(true);
    });
  }

  it('the two templates disagree about their own version and nothing else structural', () => {
    expect(templateFor('2').version).toBe('2');
    expect(templateFor('3').version).toBe('3');
    expect(templateFor('3').lengthRules).toHaveLength(1);
    expect(templateFor('2').lengthRules).toHaveLength(2);
  });
});

/** Every `clue_understood` value shown in an example (never the schema's type). */
function exampleUnderstood(text: string): number[] {
  return [...text.matchAll(/"clue_understood": ([0-9.]+)/g)].map((match) => Number(match[1]));
}

/**
 * T63 acceptance 2, and T65 acceptance 1: the scale and the varied examples are
 * the half of version 2 that version 3 keeps, so both versions are asserted.
 * 5,258 of the 5,279 parsed seed responses on the canonical bench reported
 * exactly 0.9, which is the number version 1's single example hard-coded, so
 * the escalation trigger at 0.4 could never fire; nothing in the paired
 * decomposition implicated the fix for that, so it stays untouched.
 */
describe.each(PROMPT_VERSIONS)('clue_understood guidance, version %s', (version) => {
  const withSchema = inline(version);
  const system = systemText(renderPrompt(SEED_REQUEST, 'seed', withSchema));

  it('describes the scale in words rather than by example alone', () => {
    expect(system).toContain(
      '1.0 only when the clue is unambiguous and your best answer is certain',
    );
    expect(system).toContain(
      'around 0.5 when you understand what the clue is asking but the answer is a guess',
    );
    expect(system).toContain('below 0.3 when the clue itself is opaque to you');
    expect(system).toContain('the same number on every clue tells the solver nothing');
  });

  it('says it is a routing signal and not a score for any answer', () => {
    expect(system).toContain('It is a routing signal, not a score for any answer');
  });

  it('varies the single form\'s examples, with one at or below 0.5', () => {
    const values = exampleUnderstood(system);
    expect(values).toEqual([1, 0.5]);
    expect(Math.min(...values)).toBeLessThanOrEqual(0.5);
  });

  it('varies the batched form\'s examples too, with one at or below 0.5', () => {
    const values = exampleUnderstood(
      systemText(renderBatchedSeedPrompt(BATCH_REQUESTS, withSchema)),
    );
    expect(values).toEqual([1, 0.5]);
  });

  it('hard-codes 0.9 nowhere, in any template', () => {
    for (const kind of ['seed', 'constrained', 'escalate'] as const) {
      expect(
        exampleUnderstood(systemText(renderPrompt(SEED_REQUEST, kind, withSchema))),
      ).not.toContain(0.9);
    }
  });

  it('shows the low example on a clue that is in neither synthetic fixture', () => {
    // A worked example carrying a fixture's own answer would leak it into every
    // prompt that fixture's run sends.
    expect(system).toContain('Clue 5D: Charge');
    expect(system).not.toContain('Former partner');
  });
});

describe('the same string goes to both tiers', () => {
  it('renders identically for tier 1 and tier 2', () => {
    const tier1 = renderPrompt(request({ tier: 1 }), 'seed', INLINE);
    const tier2 = renderPrompt(request({ tier: 2 }), 'seed', INLINE);
    expect(serialise(tier1)).toBe(serialise(tier2));
  });

  it('names no model anywhere in a rendered prompt or in the source', () => {
    const everything = [
      flatten(renderPrompt(SEED_REQUEST, 'seed', INLINE)),
      flatten(renderPrompt(REASK_REQUEST, 'constrained', INLINE)),
      flatten(renderPrompt(ESCALATE_REQUEST, 'escalate', INLINE)),
      flatten(renderBatchedSeedPrompt(BATCH_REQUESTS, INLINE)),
      readFileSync(PROMPTS_SOURCE, 'utf8'),
    ].join('\n');
    expect(everything.toLowerCase()).not.toContain('nemotron');
    expect(everything.toLowerCase()).not.toContain('deepseek');
  });
});

describe('purity', () => {
  it('renders the same bytes twice for the same input', () => {
    expect(serialise(renderPrompt(ESCALATE_REQUEST, 'escalate', INLINE))).toBe(
      serialise(renderPrompt(ESCALATE_REQUEST, 'escalate', INLINE)),
    );
  });

  it('does not mutate the request it is given', () => {
    const before = JSON.stringify(ESCALATE_REQUEST);
    renderPrompt(ESCALATE_REQUEST, 'escalate', INLINE);
    expect(JSON.stringify(ESCALATE_REQUEST)).toBe(before);
  });

  it('is ASCII only, so a golden file can be compared byte for byte', () => {
    const text = flatten(renderPrompt(SEED_REQUEST, 'seed', INLINE));
    expect([...text].find((character) => character.charCodeAt(0) > 127)).toBeUndefined();
  });
});


/**
 * T65 acceptance 2: the version a profile carries is the version that renders,
 * and it is the same value the cache key is built from.
 *
 * This is the contract the whole paired measurement rests on. `baseline` and
 * `baseline-pv2` are the same profile but for `promptVersion`, so if the
 * service rendered from a module constant instead of the profile the two runs
 * would send identical prompts; and if the key did not carry the version, the
 * second run would be served the first run's cached answers. Asserted end to
 * end through `createCandidateService` with a stubbed transport rather than on
 * the renderer alone, because both halves live in the service.
 */
describe('the candidate service renders the profile version (T65, acceptance 2)', () => {
  let cacheDir: string;

  beforeEach(() => {
    resetRegistryForTests();
    cacheDir = mkdtempSync(join(tmpdir(), 'xw-t65-'));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  const SERVICE_REQUEST: CandidateRequest = {
    slotId: '1A',
    clue: 'Chaos and destruction',
    length: 5,
    pattern: '?????',
    style: 'american',
    rejected: [],
    tier: 1,
    purpose: 'seed',
    n: 3,
    samples: 1,
    sampleIndex: 0,
  };

  /** One seed call under one profile version; returns what was sent and under which key. */
  async function askUnder(version: string): Promise<{ prompt: string; key: string }> {
    const records: InferenceLogRecord[] = [];
    const inferenceLog: InferenceLog = {
      write(record) {
        records.push(record);
      },
      close() {
        // nothing to flush
      },
    };
    const transport = stubTransport(singleBody([['HAVOC', 0.9]]));
    const service = createCandidateService({
      transport,
      cache: openCandidateCache({ cacheDir }),
      inferenceLog,
      profile: ProfileObject.parse({ name: 't65', promptVersion: version }),
      emit: () => {
        // events are not what this test is about
      },
      runId: 'run-1',
      puzzleId: 'puz-1',
      offline: false,
      offlineLenient: false,
    });

    await service.getCandidates(SERVICE_REQUEST);

    const sent = transport.calls[0];
    expect(sent).toBeDefined();
    const record = records[0];
    expect(record).toBeDefined();
    expect(record?.promptVersion).toBe(version);
    return {
      prompt: (sent?.messages ?? []).map((message) => message.content).join('\n'),
      key: record?.cacheKey ?? '',
    };
  }

  it('sends version 2 for a pv2 profile, version 3 for the default, under different keys', async () => {
    const v2 = await askUnder('2');
    const v3 = await askUnder('3');

    expect(v2.prompt).toContain('count each answer');
    expect(v3.prompt).not.toContain('count each answer');
    expect(v3.prompt).toContain('Every answer for 1A is exactly 5 letters long.');
    expect(v2.prompt).not.toBe(v3.prompt);
    expect(v2.key).not.toBe(v3.key);
  });

  it('renders the built-in profiles the same way: baseline is 2, baseline-pv3 is 3', () => {
    const builtins = getBuiltins();
    const baseline = builtins['baseline'];
    const pv3 = builtins['baseline-pv3'];
    expect(baseline?.promptVersion).toBe('2');
    expect(pv3?.promptVersion).toBe('3');
    const { name: _baselineName, ...baselineRest } = baseline ?? { name: '' };
    const { name: _pv3Name, ...pv3Rest } = pv3 ?? { name: '' };
    // Same profile but for the version: that is what makes the run paired.
    expect({ ...pv3Rest, promptVersion: '2' }).toEqual(baselineRest);
  });

  it('refuses a profile carrying a version it cannot render', () => {
    expect(() =>
      createCandidateService({
        transport: stubTransport(),
        cache: openCandidateCache({ cacheDir }),
        inferenceLog: {
          write() {
            // unused
          },
          close() {
            // unused
          },
        },
        profile: ProfileObject.parse({ name: 't65-bad', promptVersion: '1' }),
        emit: () => {
          // unused
        },
        runId: null,
        puzzleId: null,
        offline: false,
        offlineLenient: false,
      }),
    ).toThrow(/promptVersion/);
  });
});
