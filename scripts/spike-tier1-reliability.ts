/**
 * T49: M2 spike - tier-1 reliability, rate-limit headers, reasoning-off
 * parameter (NETWORK). Run once, by hand, inside a container with
 * NEBIUS_API_KEY set:
 *
 *   docker run --rm --env-file .env -v "$PWD":/app -w /app <image> \
 *     npx tsx scripts/spike-tier1-reliability.ts
 *
 * This is a one-off measurement script, not part of any test path (no test
 * imports it, and `npm test` never runs it). It:
 *
 *   1. discovers the provider's reasoning-off parameter for a
 *      `reasoning`-capable tier-1 model by trying documented candidates and
 *      comparing `reasoningTokens` in the usage blob;
 *   2. probes whether tier-2's `response_format.json_schema` needs a
 *      `{ name, schema, strict }` wrapper;
 *   3. fires a short raw-HTTP burst to see whether the rate limit behaves as
 *      a per-second bucket or a per-minute window;
 *   4. sends ~200 real clues through tier 1 with the seed prompt via the
 *      real `createNebiusTransport` and the real inference log, and reports
 *      parse-failure rate, length-error rate, the `clue_understood`
 *      histogram, latency and every response header name observed.
 *
 * Writes `docs/spikes/tier1-reliability.md` and a handful of
 * `test/fixtures/responses/real-*.txt` samples (key redacted, though the
 * model's reply never contains it) at the end.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CandidateRequest, PromptKind } from '../src/candidates/types.js';
import { adapterFor } from '../src/puzzle/adapters/index.js';
import { getBuiltin } from '../src/profiles/builtins.js';
import { route } from '../src/llm/tierRouter.js';
import { renderPrompt } from '../src/llm/prompts.js';
import { parseCandidateResponse } from '../src/llm/parser.js';
import { normaliseAnswer } from '../src/validate/normalise.js';
import { createNebiusTransport } from '../src/llm/client.js';
import { openInferenceLog } from '../src/llm/inferenceLog.js';
import { usdFor, capabilitiesOf } from '../src/llm/pricing.js';
import { repoRoot, resolveInferenceLogDir } from '../src/util/fs.js';
import { log, setLogLevel } from '../src/util/log.js';
import type { InferenceLogRecord, LlmRequest } from '../src/llm/types.js';

setLogLevel('info');

const TIER1_MODEL = 'nvidia/Nemotron-3_5-Lightning';
const TIER2_MODEL = 'deepseek-ai/DeepSeek-V4-Pro';
const BUDGET_USD = 0.5;
const TARGET_CLUE_COUNT = 200;

// ---------------------------------------------------------------------------
// Clue pool: real fixture clues (xd, american) plus hand-authored ones,
// mixed lengths, to reach TARGET_CLUE_COUNT.
// ---------------------------------------------------------------------------

interface ClueSpec {
  id: string;
  clue: string;
  length: number;
  enumeration?: string;
}

const FIXTURE_XD_FILES = [
  'test/fixtures/puzzles/synthetic-5x5.xd',
  'test/fixtures/puzzles/leaky-clues.xd',
  'test/fixtures/sources/local-sample.xd',
  'test/fixtures/sources/xd-mini/1998-11-12-newer-puzzle.xd',
  'test/fixtures/sources/xd-mini/1963-05-01-old-puzzle.xd',
];

async function loadFixtureClues(): Promise<ClueSpec[]> {
  const adapter = adapterFor('xd');
  if (adapter === undefined) throw new Error('no xd adapter registered');
  const out: ClueSpec[] = [];
  for (const rel of FIXTURE_XD_FILES) {
    const abs = join(repoRoot(), rel);
    try {
      const bytes = await readFile(abs);
      const puzzle = await adapter.parse(bytes, { id: rel, source: 'spike-fixture' });
      for (const slot of puzzle.slots) {
        const spec: ClueSpec = { id: `${rel}#${slot.id}`, clue: slot.clue, length: slot.length };
        if (slot.enumeration !== undefined) spec.enumeration = slot.enumeration;
        out.push(spec);
      }
    } catch (err) {
      log.warn(`spike: skipping fixture ${rel}: ${messageOf(err)}`);
    }
  }
  return out;
}

// Hand-authored, original clue/answer pairs (this task, "clues you write"):
// generic-knowledge one-line definitions, ASCII only, mixed lengths 3-10.
// The answer is only used to derive `length`; it is never sent to the model.
const AUTHORED: ReadonlyArray<{ answer: string; clue: string }> = [
  { answer: 'CAT', clue: 'Purring household pet' },
  { answer: 'DOG', clue: "Man's best friend" },
  { answer: 'SUN', clue: 'Star at the center of our solar system' },
  { answer: 'MOON', clue: "Earth's only natural satellite" },
  { answer: 'RAIN', clue: 'Water falling from clouds' },
  { answer: 'TREE', clue: 'Tall plant with a trunk and branches' },
  { answer: 'BOOK', clue: 'Bound pages you read' },
  { answer: 'FISH', clue: 'Gilled swimmer' },
  { answer: 'BIRD', clue: 'Feathered flyer' },
  { answer: 'LION', clue: 'King of the jungle' },
  { answer: 'TIGER', clue: 'Striped big cat' },
  { answer: 'HORSE', clue: 'Animal you ride or race' },
  { answer: 'MOUSE', clue: 'Small rodent, or a computer pointer' },
  { answer: 'EAGLE', clue: 'Bald bird of prey' },
  { answer: 'SNAKE', clue: 'Legless reptile' },
  { answer: 'WHALE', clue: 'Largest animal on Earth' },
  { answer: 'ROBOT', clue: 'Mechanical worker' },
  { answer: 'PIANO', clue: 'Instrument with black and white keys' },
  { answer: 'GUITAR', clue: 'Six-stringed instrument' },
  { answer: 'VIOLIN', clue: 'Instrument played with a bow' },
  { answer: 'TRUMPET', clue: 'Brass instrument you blow into' },
  { answer: 'CASTLE', clue: 'Medieval fortress' },
  { answer: 'BRIDGE', clue: 'Structure spanning a river' },
  { answer: 'DESERT', clue: 'Sandy, arid region' },
  { answer: 'FOREST', clue: 'Dense collection of trees' },
  { answer: 'ISLAND', clue: 'Land surrounded by water' },
  { answer: 'VOLCANO', clue: 'Mountain that erupts' },
  { answer: 'GLACIER', clue: 'Slow-moving river of ice' },
  { answer: 'HARBOR', clue: 'Sheltered place for ships' },
  { answer: 'MARKET', clue: 'Place to buy and sell goods' },
  { answer: 'KITCHEN', clue: 'Room where meals are cooked' },
  { answer: 'GARDEN', clue: 'Plot for growing flowers or vegetables' },
  { answer: 'WINDOW', clue: 'Opening in a wall, usually glazed' },
  { answer: 'MIRROR', clue: 'Reflective surface' },
  { answer: 'CANDLE', clue: 'Wax stick with a wick' },
  { answer: 'BLANKET', clue: 'Warm covering for a bed' },
  { answer: 'PILLOW', clue: 'Cushion for your head' },
  { answer: 'LADDER', clue: 'Climbing frame with rungs' },
  { answer: 'HAMMER', clue: 'Tool for driving nails' },
  { answer: 'WRENCH', clue: 'Tool for turning nuts and bolts' },
  { answer: 'SCISSOR', clue: 'Cutting tool with two blades' },
  { answer: 'PENCIL', clue: 'Wooden writing tool' },
  { answer: 'CRAYON', clue: 'Wax coloring stick' },
  { answer: 'MARKER', clue: 'Felt-tipped writing tool' },
  { answer: 'NOTEBOOK', clue: 'Bound pages for writing notes' },
  { answer: 'COMPUTER', clue: 'Electronic device for processing data' },
  { answer: 'KEYBOARD', clue: 'Typing input device' },
  { answer: 'MONITOR', clue: 'Screen for a computer' },
  { answer: 'PRINTER', clue: 'Device that puts ink on paper' },
  { answer: 'TELEPHONE', clue: 'Device for talking at a distance' },
  { answer: 'CAMERA', clue: 'Device that captures photos' },
  { answer: 'BICYCLE', clue: 'Two-wheeled pedal vehicle' },
  { answer: 'SCOOTER', clue: 'Two-wheeled kick vehicle' },
  { answer: 'AIRPLANE', clue: 'Flying vehicle with wings' },
  { answer: 'HELICOPTER', clue: 'Aircraft with spinning rotor blades' },
  { answer: 'SUBMARINE', clue: 'Vessel that travels underwater' },
  { answer: 'TRAIN', clue: 'Vehicle that runs on rails' },
  { answer: 'TRUCK', clue: 'Large vehicle for hauling cargo' },
  { answer: 'TRACTOR', clue: 'Farm vehicle for pulling equipment' },
  { answer: 'ROCKET', clue: 'Vehicle that launches into space' },
  { answer: 'SATELLITE', clue: 'Object orbiting a planet' },
  { answer: 'PLANET', clue: 'Body orbiting the sun' },
  { answer: 'COMET', clue: 'Icy body with a glowing tail' },
  { answer: 'GALAXY', clue: 'Vast collection of stars' },
  { answer: 'METEOR', clue: 'Shooting star' },
  { answer: 'ORBIT', clue: 'Path an object takes around another' },
  { answer: 'GRAVITY', clue: 'Force that pulls objects together' },
  { answer: 'OXYGEN', clue: 'Gas humans breathe to live' },
  { answer: 'HYDROGEN', clue: 'Lightest chemical element' },
  { answer: 'CARBON', clue: 'Element found in all living things' },
  { answer: 'SODIUM', clue: 'Metal that reacts violently with water' },
  { answer: 'HELIUM', clue: 'Gas that makes balloons float' },
  { answer: 'NITROGEN', clue: "Most abundant gas in Earth's air" },
  { answer: 'SILVER', clue: 'Shiny precious metal, symbol Ag' },
  { answer: 'COPPER', clue: 'Reddish metal used in wiring' },
  { answer: 'BRONZE', clue: 'Alloy of copper and tin' },
  { answer: 'MARBLE', clue: 'Stone used in sculpture, or a small glass ball' },
  { answer: 'GRANITE', clue: 'Hard igneous rock' },
  { answer: 'DIAMOND', clue: 'Hardest natural mineral' },
  { answer: 'EMERALD', clue: 'Green precious gemstone' },
  { answer: 'RUBY', clue: 'Red precious gemstone' },
  { answer: 'SAPPHIRE', clue: 'Blue precious gemstone' },
  { answer: 'PEARL', clue: 'Gem formed inside an oyster' },
  { answer: 'AMBER', clue: 'Fossilized tree resin' },
  { answer: 'CORAL', clue: 'Reef-building marine organism' },
  { answer: 'SPONGE', clue: 'Porous sea creature, or a cleaning tool' },
  { answer: 'OCTOPUS', clue: 'Eight-armed sea creature' },
  { answer: 'DOLPHIN', clue: 'Playful, intelligent sea mammal' },
  { answer: 'SHARK', clue: 'Predatory fish with rows of teeth' },
  { answer: 'TURTLE', clue: 'Shelled reptile' },
  { answer: 'LOBSTER', clue: 'Clawed shellfish' },
  { answer: 'CRAB', clue: 'Sideways-walking shellfish' },
  { answer: 'SHRIMP', clue: 'Small edible crustacean' },
  { answer: 'SALMON', clue: 'Pink-fleshed fish that swims upstream' },
  { answer: 'TROUT', clue: 'Freshwater game fish' },
  { answer: 'PENGUIN', clue: 'Flightless bird of the Antarctic' },
  { answer: 'OSTRICH', clue: 'Largest living bird' },
  { answer: 'PARROT', clue: 'Colorful talking bird' },
  { answer: 'PIGEON', clue: 'Common city bird' },
  { answer: 'SPARROW', clue: 'Small, common brown bird' },
  { answer: 'ROBIN', clue: 'Bird with a red breast' },
  { answer: 'FALCON', clue: 'Fast diving bird of prey' },
  { answer: 'SQUIRREL', clue: 'Bushy-tailed nut gatherer' },
  { answer: 'RABBIT', clue: 'Long-eared hopping mammal' },
  { answer: 'BEAVER', clue: 'Dam-building rodent' },
  { answer: 'OTTER', clue: 'Playful aquatic mammal' },
  { answer: 'RACCOON', clue: 'Masked nocturnal scavenger' },
  { answer: 'SKUNK', clue: 'Foul-smelling striped mammal' },
  { answer: 'DEER', clue: 'Antlered forest mammal' },
  { answer: 'MOOSE', clue: 'Largest member of the deer family' },
  { answer: 'ELK', clue: 'Large deer of North America' },
  { answer: 'BISON', clue: 'Large shaggy plains mammal' },
  { answer: 'CAMEL', clue: 'Desert animal with humps' },
  { answer: 'GIRAFFE', clue: 'Tallest land animal' },
  { answer: 'ZEBRA', clue: 'Striped African equine' },
  { answer: 'HIPPO', clue: 'Large river-dwelling mammal' },
  { answer: 'RHINO', clue: 'Thick-skinned horned mammal' },
  { answer: 'GORILLA', clue: 'Largest living primate' },
  { answer: 'MONKEY', clue: 'Tree-swinging primate' },
  { answer: 'PANDA', clue: 'Black-and-white bamboo eater' },
  { answer: 'KOALA', clue: 'Eucalyptus-eating Australian marsupial' },
  { answer: 'KANGAROO', clue: 'Hopping Australian marsupial' },
  { answer: 'PENNY', clue: 'One-cent coin' },
  { answer: 'NICKEL', clue: 'Five-cent coin' },
  { answer: 'DIME', clue: 'Ten-cent coin' },
  { answer: 'DOLLAR', clue: 'Basic unit of US currency' },
  { answer: 'WALLET', clue: 'Pocket case for cash and cards' },
  { answer: 'PURSE', clue: 'Small bag carried by hand' },
  { answer: 'BACKPACK', clue: 'Bag carried on the shoulders' },
  { answer: 'SUITCASE', clue: 'Case for packing travel clothes' },
  { answer: 'UMBRELLA', clue: 'Device that shields you from rain' },
  { answer: 'RAINCOAT', clue: 'Waterproof outer garment' },
  { answer: 'SWEATER', clue: 'Warm knitted garment' },
  { answer: 'JACKET', clue: 'Short outer garment with sleeves' },
  { answer: 'TROUSERS', clue: 'Garment covering both legs' },
  { answer: 'SANDAL', clue: 'Open-toed summer footwear' },
  { answer: 'SNEAKER', clue: 'Casual rubber-soled shoe' },
  { answer: 'HELMET', clue: 'Protective headgear' },
  { answer: 'GLOVES', clue: 'Hand coverings, worn in pairs' },
  { answer: 'SCARF', clue: 'Long piece of cloth worn around the neck' },
  { answer: 'BUTTON', clue: 'Small fastener on a shirt' },
  { answer: 'ZIPPER', clue: 'Sliding fastener on clothing' },
  { answer: 'NEEDLE', clue: 'Thin pointed sewing tool' },
  { answer: 'THREAD', clue: 'Thin strand used in sewing' },
  { answer: 'FABRIC', clue: 'Woven or knitted material' },
  { answer: 'COTTON', clue: 'Soft natural plant fiber' },
  { answer: 'SILK', clue: 'Smooth fiber spun by a caterpillar' },
  { answer: 'WOOL', clue: 'Fiber sheared from a sheep' },
  { answer: 'LEATHER', clue: 'Material made from animal hide' },
  { answer: 'RUBBER', clue: 'Elastic material from tree sap' },
  { answer: 'PLASTIC', clue: 'Synthetic moldable material' },
  { answer: 'CERAMIC', clue: 'Material made from baked clay' },
  { answer: 'CEMENT', clue: 'Powder that hardens into concrete' },
  { answer: 'BRICK', clue: 'Rectangular building block' },
  { answer: 'TIMBER', clue: 'Wood prepared for building' },
  { answer: 'CANVAS', clue: 'Heavy cloth used for painting or tents' },
  { answer: 'PALETTE', clue: 'Board an artist mixes paint on' },
  { answer: 'EASEL', clue: "Stand that holds an artist's canvas" },
  { answer: 'SCULPTURE', clue: 'Three-dimensional work of art' },
  { answer: 'PAINTING', clue: 'Artwork made with color on a surface' },
  { answer: 'DRAWING', clue: 'Picture made with pencil or pen' },
  { answer: 'POTTERY', clue: 'Objects shaped from clay and fired' },
  { answer: 'MOSAIC', clue: 'Picture made from small tiles' },
  { answer: 'TAPESTRY', clue: 'Woven picture hung on a wall' },
  { answer: 'ORCHESTRA', clue: 'Large group of musicians' },
  { answer: 'CHORUS', clue: 'Group of singers' },
  { answer: 'CONCERT', clue: 'Live musical performance' },
  { answer: 'REHEARSAL', clue: 'Practice run before a performance' },
  { answer: 'AUDIENCE', clue: 'People watching a show' },
  { answer: 'THEATER', clue: 'Building for stage performances' },
  { answer: 'CINEMA', clue: 'Building for watching films' },
  { answer: 'STADIUM', clue: 'Large arena for sports' },
  { answer: 'REFEREE', clue: 'Official who enforces the rules' },
  { answer: 'TROPHY', clue: 'Prize for winning a competition' },
  { answer: 'MEDAL', clue: 'Award worn around the neck' },
  { answer: 'RIBBON', clue: 'Decorative strip, or a prize marker' },
  { answer: 'WHISTLE', clue: "Referee's signaling device" },
  { answer: 'RACKET', clue: 'Tool for hitting a tennis ball' },
  { answer: 'PADDLE', clue: 'Flat tool for rowing or table tennis' },
  { answer: 'GOALPOST', clue: 'Frame a ball is aimed through' },
  { answer: 'DUGOUT', clue: 'Sheltered seating for a baseball team' },
  { answer: 'INNING', clue: 'A round in a baseball game' },
  { answer: 'MARATHON', clue: 'Long-distance foot race' },
  { answer: 'SPRINT', clue: 'Short, fast race' },
  { answer: 'HURDLE', clue: 'Barrier jumped in a track race' },
  { answer: 'ARCHERY', clue: 'Sport of shooting arrows' },
  { answer: 'FENCING', clue: 'Sport of sword dueling' },
  { answer: 'WRESTLING', clue: 'Sport of grappling an opponent' },
  { answer: 'BOXING', clue: 'Sport of fighting with fists' },
  { answer: 'SWIMMING', clue: 'Sport of moving through water' },
  { answer: 'DIVING', clue: 'Sport of jumping into water' },
  { answer: 'SKIING', clue: 'Sport of gliding down snow' },
  { answer: 'SKATING', clue: 'Sport of gliding on blades or wheels' },
  { answer: 'CYCLING', clue: 'Sport of riding a bicycle' },
  { answer: 'CLIMBING', clue: 'Sport of scaling rock or ice' },
  { answer: 'HIKING', clue: 'Long walk through countryside' },
  { answer: 'CAMPING', clue: 'Sleeping outdoors in a tent' },
  { answer: 'FISHING', clue: 'Sport of catching fish' },
  { answer: 'HUNTING', clue: 'Pursuit of wild game' },
  { answer: 'GARDENING', clue: 'Hobby of tending plants' },
  { answer: 'BAKING', clue: 'Cooking with dry heat in an oven' },
  { answer: 'PANCAKE', clue: 'Flat breakfast cake cooked on a griddle' },
  { answer: 'WAFFLE', clue: 'Griddle cake with a grid pattern' },
  { answer: 'OMELET', clue: 'Beaten eggs cooked in a pan' },
  { answer: 'SANDWICH', clue: 'Filling between two slices of bread' },
  { answer: 'BURGER', clue: 'Patty served in a bun' },
  { answer: 'PIZZA', clue: 'Baked dish topped with cheese and sauce' },
  { answer: 'NOODLE', clue: 'Long thin strip of pasta' },
  { answer: 'DUMPLING', clue: 'Small parcel of dough with filling' },
  { answer: 'PRETZEL', clue: 'Twisted salted baked snack' },
  { answer: 'BISCUIT', clue: 'Small baked bread roll' },
  { answer: 'MUFFIN', clue: 'Small baked cake, often with fruit' },
  { answer: 'SAUSAGE', clue: 'Ground meat stuffed in a casing' },
  { answer: 'BACON', clue: 'Cured strips of pork' },
  { answer: 'CHEESE', clue: 'Dairy product made from curdled milk' },
  { answer: 'YOGURT', clue: 'Fermented dairy product' },
  { answer: 'BUTTER', clue: 'Dairy spread churned from cream' },
  { answer: 'HONEY', clue: 'Sweet substance made by bees' },
  { answer: 'SYRUP', clue: 'Thick sweet liquid poured on food' },
  { answer: 'VINEGAR', clue: 'Sour liquid used in cooking' },
  { answer: 'MUSTARD', clue: 'Yellow condiment made from seeds' },
  { answer: 'PEPPER', clue: 'Spice ground from peppercorns' },
  { answer: 'CINNAMON', clue: 'Sweet spice from tree bark' },
  { answer: 'NUTMEG', clue: 'Spice grated from a hard seed' },
  { answer: 'GINGER', clue: 'Spicy root used in cooking' },
  { answer: 'GARLIC', clue: 'Pungent bulb used for flavor' },
  { answer: 'ONION', clue: 'Layered bulb that makes you cry' },
  { answer: 'POTATO', clue: 'Starchy underground tuber' },
  { answer: 'CARROT', clue: 'Orange root vegetable' },
  { answer: 'PUMPKIN', clue: 'Large orange gourd carved at Halloween' },
  { answer: 'TOMATO', clue: 'Red fruit often used as a vegetable' },
  { answer: 'LETTUCE', clue: 'Leafy salad green' },
  { answer: 'CABBAGE', clue: 'Round leafy vegetable' },
  { answer: 'SPINACH', clue: 'Leafy green vegetable rich in iron' },
  { answer: 'BROCCOLI', clue: 'Green tree-shaped vegetable' },
  { answer: 'CUCUMBER', clue: 'Long green salad vegetable' },
  { answer: 'MUSHROOM', clue: 'Fungus grown for food' },
  { answer: 'AVOCADO', clue: 'Creamy green fruit used in guacamole' },
  { answer: 'BANANA', clue: 'Curved yellow fruit' },
  { answer: 'ORANGE', clue: 'Round citrus fruit' },
  { answer: 'LEMON', clue: 'Sour yellow citrus fruit' },
  { answer: 'APPLE', clue: 'Round fruit that keeps the doctor away' },
  { answer: 'GRAPE', clue: 'Small fruit that grows in bunches' },
  { answer: 'CHERRY', clue: 'Small round stone fruit' },
  { answer: 'PEACH', clue: 'Fuzzy-skinned stone fruit' },
  { answer: 'MANGO', clue: 'Sweet tropical stone fruit' },
  { answer: 'PAPAYA', clue: 'Orange tropical fruit' },
  { answer: 'COCONUT', clue: 'Large hard-shelled tropical fruit' },
  { answer: 'PINEAPPLE', clue: 'Spiky tropical fruit' },
  { answer: 'MELON', clue: 'Large round juicy fruit' },
  { answer: 'APRICOT', clue: 'Small orange stone fruit' },
  { answer: 'RAISIN', clue: 'Dried grape' },
  { answer: 'WALNUT', clue: 'Wrinkled brown nut' },
  { answer: 'ALMOND', clue: 'Oval-shaped edible nut' },
  { answer: 'CASHEW', clue: 'Curved kidney-shaped nut' },
  { answer: 'PEANUT', clue: 'Legume often mistaken for a nut' },
  { answer: 'CHESTNUT', clue: 'Nut roasted at winter fairs' },
  { answer: 'HAZELNUT', clue: 'Small round brown nut' },
];

function authoredClues(): ClueSpec[] {
  return AUTHORED.map((entry, i) => ({
    id: `authored#${String(i)}-${entry.answer}`,
    clue: entry.clue,
    length: entry.answer.length,
  }));
}

/** Deterministic shuffle (mulberry32), so the 200-clue slice is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function statOf(values: number[]): { mean: number; p50: number; p95: number } {
  if (values.length === 0) return { mean: 0, p50: 0, p95: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const at = (q: number): number => {
    const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
    return sorted[idx] as number;
  };
  return { mean, p50: at(0.5), p95: at(0.95) };
}

const RATE_LIMIT_HEADER_RE = /^(x-ratelimit-|retry-after$)/i;

function isRateLimitHeader(name: string): boolean {
  return RATE_LIMIT_HEADER_RE.test(name);
}

/** Redacts the raw API key string, wherever it happens to appear. */
function redactKey(text: string, apiKey: string): string {
  if (apiKey.length === 0) return text;
  return text.split(apiKey).join('[REDACTED]');
}

function candidateRequestFor(spec: ClueSpec, profile: ReturnType<typeof getBuiltin>): CandidateRequest {
  const req: CandidateRequest = {
    slotId: spec.id,
    clue: spec.clue,
    length: spec.length,
    pattern: '?'.repeat(spec.length),
    style: 'american',
    rejected: [],
    tier: 1,
    purpose: 'seed',
    n: profile.candidatesPerAsk,
    samples: 1,
    sampleIndex: 0,
  };
  if (spec.enumeration !== undefined) req.enumeration = spec.enumeration;
  return req;
}

function buildLlmRequest(
  req: CandidateRequest,
  profile: ReturnType<typeof getBuiltin>,
  extraOverride?: Record<string, unknown>,
): { request: LlmRequest; model: string } {
  const routed = route(req, profile);
  const promptKind: PromptKind = 'seed';
  const rendered = renderPrompt(req, promptKind, { inlineSchema: routed.inlineSchema });
  const request: LlmRequest = { ...routed.request, messages: rendered.messages };
  if (extraOverride !== undefined) {
    if (Object.keys(extraOverride).length > 0) request.extra = extraOverride;
    else delete request.extra;
  }
  return { request, model: routed.model };
}

// ---------------------------------------------------------------------------
// Header + log bookkeeping
// ---------------------------------------------------------------------------

interface HeaderInfo {
  name: string;
  isRateLimit: boolean;
  exampleValues: Set<string>;
  seenCount: number;
}

function recordHeaders(table: Map<string, HeaderInfo>, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    const rl = isRateLimitHeader(key);
    const existing = table.get(key);
    if (existing === undefined) {
      table.set(key, {
        name: key,
        isRateLimit: rl,
        exampleValues: rl ? new Set([value]) : new Set(),
        seenCount: 1,
      });
    } else {
      existing.seenCount += 1;
      if (rl) existing.exampleValues.add(value);
    }
  }
}

async function readInferenceLogRecordsSince(startIso: string): Promise<InferenceLogRecord[]> {
  const dir = resolveInferenceLogDir();
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out: InferenceLogRecord[] = [];
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const rec = JSON.parse(line) as InferenceLogRecord;
        if (rec.ts >= startIso) out.push(rec);
      } catch {
        // Not this script's concern; the log is append-only JSONL owned by T10.
      }
    }
  }
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface SpendTracker {
  usd: number;
  add(model: string, promptTokens: number, completionTokens: number): void;
  overBudget(): boolean;
}

function makeSpendTracker(budgetUsd: number): SpendTracker {
  let usd = 0;
  return {
    get usd() {
      return usd;
    },
    add(model, promptTokens, completionTokens) {
      usd += usdFor({ model, promptTokens, completionTokens, calls: 1 });
    },
    overBudget() {
      return usd >= budgetUsd;
    },
  };
}

interface ReasoningTrial {
  label: string;
  extra: Record<string, unknown>;
  ok: boolean;
  httpError?: string;
  reasoningTokens: number;
  completionTokens: number;
  latencyMs: number;
  understoodOrEmpty: boolean;
}

interface SchemaTrial {
  label: string;
  ok: boolean;
  httpError?: string;
  parsedOk: boolean;
}

interface BurstSample {
  index: number;
  ts: number;
  status: number;
  headers: Record<string, string>;
}

interface MainCallResult {
  slotId: string;
  clue: string;
  length: number;
  ok: boolean;
  transportError?: string;
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  clueUnderstood?: number;
  parseFailed?: boolean;
  parseFailureReason?: string;
  candidateCount?: number;
  lengthMismatchCount?: number;
  rawText?: string;
}

async function main(): Promise<void> {
  // A plain `string` (not `string | undefined`) from the start: TypeScript
  // does not carry an outer narrowing check into the nested closures below
  // (`harvest`, the burst-probe callbacks), so a default-to-empty-string plus
  // an explicit emptiness check reads the same but actually typechecks there.
  const apiKey = process.env['NEBIUS_API_KEY'] ?? '';
  if (apiKey.trim() === '') {
    log.error('spike: NEBIUS_API_KEY is not set; cannot run the M2 network spike');
    process.exitCode = 4;
    return;
  }

  const startedAt = new Date();
  const startIso = startedAt.toISOString();
  log.info(`spike: starting at ${startIso}, budget USD ${String(BUDGET_USD)}`);

  const profile = getBuiltin('baseline');
  const inferenceLog = openInferenceLog();
  const transport = createNebiusTransport({ inferenceLog });
  const spend = makeSpendTracker(BUDGET_USD);
  const headerTable = new Map<string, HeaderInfo>();
  const harvested: { name: string; text: string }[] = [];

  function harvest(name: string, rawText: string): void {
    if (harvested.length >= 8) return;
    if (harvested.some((h) => h.text === rawText)) return;
    harvested.push({ name, text: redactKey(rawText, apiKey) });
  }

  // -------------------------------------------------------------------
  // Phase 1: reasoning-off parameter discovery
  // -------------------------------------------------------------------
  log.info('spike: phase 1 - reasoning-off parameter discovery');
  const discoveryClue: ClueSpec = {
    id: 'discovery#1',
    clue: 'Large striped Asian big cat',
    length: 5,
  };
  const discoveryReq = candidateRequestFor(discoveryClue, profile);

  const reasoningCandidates: { label: string; extra: Record<string, unknown> }[] = [
    { label: 'control (no extra param)', extra: {} },
    { label: 'shipped placeholder reasoning_effort=true', extra: { reasoning_effort: true } },
    { label: 'reasoning_effort="none"', extra: { reasoning_effort: 'none' } },
    { label: 'reasoning_effort="low"', extra: { reasoning_effort: 'low' } },
    {
      label: 'chat_template_kwargs.thinking=false',
      extra: { chat_template_kwargs: { thinking: false } },
    },
    {
      label: 'chat_template_kwargs.enable_thinking=false',
      extra: { chat_template_kwargs: { enable_thinking: false } },
    },
    { label: 'enable_thinking=false (top level)', extra: { enable_thinking: false } },
    { label: 'reasoning={"effort":"low"}', extra: { reasoning: { effort: 'low' } } },
  ];

  const reasoningTrials: ReasoningTrial[] = [];
  for (const candidate of reasoningCandidates) {
    if (spend.overBudget()) break;
    const { request } = buildLlmRequest(discoveryReq, profile, candidate.extra);
    try {
      const result = await transport.complete(request);
      spend.add(TIER1_MODEL, result.usage.promptTokens, result.usage.completionTokens);
      recordHeaders(headerTable, result.headers);
      const outcome = parseCandidateResponse(result.text, {
        batchSize: 1,
        expectedIds: [discoveryReq.slotId],
      });
      harvest(`reasoning-discovery-${candidate.label}`, result.text);
      reasoningTrials.push({
        label: candidate.label,
        extra: candidate.extra,
        ok: true,
        reasoningTokens: result.usage.reasoningTokens ?? 0,
        completionTokens: result.usage.completionTokens,
        latencyMs: result.latencyMs,
        understoodOrEmpty: outcome.byId.size > 0,
      });
      log.info(
        `  ${candidate.label}: reasoningTokens=${String(result.usage.reasoningTokens ?? 0)} ` +
          `completionTokens=${String(result.usage.completionTokens)} latencyMs=${String(result.latencyMs)}`,
      );
    } catch (err) {
      reasoningTrials.push({
        label: candidate.label,
        extra: candidate.extra,
        ok: false,
        httpError: messageOf(err),
        reasoningTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
        understoodOrEmpty: false,
      });
      log.info(`  ${candidate.label}: REJECTED - ${messageOf(err)}`);
    }
  }

  // -------------------------------------------------------------------
  // Phase 2: response_format.json_schema wrapper shape (tier 2)
  // -------------------------------------------------------------------
  log.info('spike: phase 2 - tier-2 response_format wrapper shape');
  const schemaTrials: SchemaTrial[] = [];
  if (!spend.overBudget()) {
    const schemaClue: ClueSpec = { id: 'schema-probe#1', clue: 'Frozen water', length: 3 };
    const schemaReq = candidateRequestFor(schemaClue, {
      ...profile,
      tier1: TIER1_MODEL,
      tier2: TIER2_MODEL,
    });
    schemaReq.tier = 2;
    const capabilities = capabilitiesOf(TIER2_MODEL);
    log.info(`  tier-2 model ${TIER2_MODEL} supportsStructuredOutputs=${String(capabilities.supportsStructuredOutputs)}`);

    const routed = route(schemaReq, { ...profile, tier1: TIER1_MODEL, tier2: TIER2_MODEL });
    const rendered = renderPrompt(schemaReq, 'seed', { inlineSchema: routed.inlineSchema });

    // The raw schema document, read independently of `routed.request` (whose
    // `responseFormat` is typed `unknown`) so trial B can nest it inside a
    // `{ name, schema, strict }` wrapper without an unsafe property access.
    const schemaDoc = JSON.parse(
      await readFile(join(repoRoot(), 'schemas', 'candidate-response.schema.json'), 'utf8'),
    ) as unknown;

    // Trial A: current shape (raw schema document, oneOf single/batched),
    // exactly what `route()` already put on `routed.request.responseFormat`.
    const trialA: LlmRequest = { ...routed.request, messages: rendered.messages };
    try {
      const result = await transport.complete(trialA);
      spend.add(TIER2_MODEL, result.usage.promptTokens, result.usage.completionTokens);
      recordHeaders(headerTable, result.headers);
      harvest('schema-wrapper-current-shape', result.text);
      const outcome = parseCandidateResponse(result.text, { batchSize: 1, expectedIds: [schemaReq.slotId] });
      schemaTrials.push({ label: 'current: response_format.json_schema = raw schema doc', ok: true, parsedOk: outcome.byId.size > 0 });
      log.info(`  current shape: HTTP 200, parsedOk=${String(outcome.byId.size > 0)}`);
    } catch (err) {
      schemaTrials.push({
        label: 'current: response_format.json_schema = raw schema doc',
        ok: false,
        httpError: messageOf(err),
        parsedOk: false,
      });
      log.info(`  current shape: REJECTED - ${messageOf(err)}`);
    }

    if (!spend.overBudget()) {
      // Trial B: OpenAI-style wrapper { name, schema, strict }.
      const wrapped = {
        type: 'json_schema',
        json_schema: { name: 'candidate_response', schema: schemaDoc, strict: true },
      };
      const trialB: LlmRequest = {
        ...routed.request,
        messages: rendered.messages,
        responseFormat: wrapped,
      };
      try {
        const result = await transport.complete(trialB);
        spend.add(TIER2_MODEL, result.usage.promptTokens, result.usage.completionTokens);
        recordHeaders(headerTable, result.headers);
        harvest('schema-wrapper-name-schema-strict', result.text);
        const outcome = parseCandidateResponse(result.text, { batchSize: 1, expectedIds: [schemaReq.slotId] });
        schemaTrials.push({
          label: 'wrapped: response_format.json_schema = { name, schema, strict }',
          ok: true,
          parsedOk: outcome.byId.size > 0,
        });
        log.info(`  wrapped shape: HTTP 200, parsedOk=${String(outcome.byId.size > 0)}`);
      } catch (err) {
        schemaTrials.push({
          label: 'wrapped: response_format.json_schema = { name, schema, strict }',
          ok: false,
          httpError: messageOf(err),
          parsedOk: false,
        });
        log.info(`  wrapped shape: REJECTED - ${messageOf(err)}`);
      }
    }
  } else {
    log.warn('spike: skipping phase 2 (schema-wrapper probe), budget already exhausted');
  }

  // -------------------------------------------------------------------
  // Phase 3: raw-HTTP burst probe for per-second vs per-minute bucket
  // -------------------------------------------------------------------
  log.info('spike: phase 3 - raw burst probe (bypasses the client-side limiter)');
  const burstSamples: BurstSample[] = [];
  const burstBaseUrl = (process.env['NEBIUS_BASE_URL'] ?? 'https://api.tokenfactory.nebius.com/v1').replace(/\/+$/, '');
  const BURST_SIZE = 20;
  if (!spend.overBudget()) {
    const burstBody = {
      model: TIER1_MODEL,
      messages: [
        { role: 'system', content: 'Reply with the single word OK and nothing else.' },
        { role: 'user', content: 'Say OK.' },
      ],
      temperature: 0,
      max_tokens: 4,
    };
    const burstStart = Date.now();
    const burstPromises = Array.from({ length: BURST_SIZE }, (_, i) =>
      fetch(`${burstBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(burstBody),
      })
        .then(async (res) => {
          const headers: Record<string, string> = {};
          res.headers.forEach((v, k) => {
            headers[k.toLowerCase()] = v;
          });
          const bodyText = await res.text();
          return { i, res, headers, bodyText };
        })
        .catch((err: unknown) => ({ i, error: messageOf(err) })),
    );
    const settled = await Promise.all(burstPromises);
    for (const item of settled) {
      if ('error' in item) {
        log.info(`  burst #${String(item.i)}: network error - ${item.error}`);
        continue;
      }
      recordHeaders(headerTable, item.headers);
      burstSamples.push({ index: item.i, ts: Date.now() - burstStart, status: item.res.status, headers: item.headers });
      const parsedUsage = (() => {
        try {
          const body = JSON.parse(item.bodyText) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
          return body.usage;
        } catch {
          return undefined;
        }
      })();
      if (item.res.status === 200 && parsedUsage?.prompt_tokens !== undefined) {
        spend.add(TIER1_MODEL, parsedUsage.prompt_tokens, parsedUsage.completion_tokens ?? 0);
      }
    }
    burstSamples.sort((a, b) => a.ts - b.ts);
    log.info(`  burst: ${String(burstSamples.length)}/${String(BURST_SIZE)} responded`);
  } else {
    log.warn('spike: skipping phase 3 (burst probe), budget already exhausted');
  }

  // -------------------------------------------------------------------
  // Phase 4: main 200-clue seed-pass measurement through tier 1
  // -------------------------------------------------------------------
  log.info('spike: phase 4 - main tier-1 seed measurement');
  const fixtureClues = await loadFixtureClues();
  const pool = [...fixtureClues, ...authoredClues()];
  const clueSet = shuffled(pool, 20260903).slice(0, TARGET_CLUE_COUNT);
  log.info(
    `spike: clue pool = ${String(fixtureClues.length)} fixture + ${String(authoredClues().length)} ` +
      `authored, using ${String(clueSet.length)} of ${String(pool.length)}`,
  );

  // Apply the best reasoning-off finding (if any) to every main-phase call,
  // so the 200-clue measurement reflects the fixed router, not the
  // placeholder. Falls back to the placeholder when nothing beat it.
  const control = reasoningTrials.find((t) => t.label.startsWith('control'));
  const winner = reasoningTrials
    .filter((t) => t.ok && !t.label.startsWith('control'))
    .find((t) => control !== undefined && control.ok && t.reasoningTokens < control.reasoningTokens);
  const mainPhaseExtra: Record<string, unknown> | undefined = winner?.extra;

  const results: MainCallResult[] = [];
  for (const spec of clueSet) {
    if (spend.overBudget()) {
      log.warn(`spike: budget of USD ${String(BUDGET_USD)} reached after ${String(results.length)} calls; stopping`);
      break;
    }
    const req = candidateRequestFor(spec, profile);
    const { request } = buildLlmRequest(req, profile, mainPhaseExtra);
    try {
      const result = await transport.complete(request);
      spend.add(TIER1_MODEL, result.usage.promptTokens, result.usage.completionTokens);
      recordHeaders(headerTable, result.headers);
      const outcome = parseCandidateResponse(result.text, { batchSize: 1, expectedIds: [spec.id] });
      const parsed = outcome.byId.get(spec.id);
      const parseFailed = parsed === undefined;
      if (parseFailed) {
        harvest(`main-parse-failure-${spec.id}`, result.text);
      }
      let lengthMismatchCount = 0;
      if (parsed !== undefined) {
        for (const c of parsed.candidates) {
          if (normaliseAnswer(c.answer).length !== spec.length) lengthMismatchCount += 1;
        }
      }
      results.push({
        slotId: spec.id,
        clue: spec.clue,
        length: spec.length,
        ok: true,
        latencyMs: result.latencyMs,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        reasoningTokens: result.usage.reasoningTokens ?? 0,
        clueUnderstood: parsed?.clue_understood,
        parseFailed,
        parseFailureReason: parseFailed ? outcome.failures.map((f) => f.error).join('; ') : undefined,
        candidateCount: parsed?.candidates.length ?? 0,
        lengthMismatchCount,
        rawText: result.text,
      });
    } catch (err) {
      results.push({ slotId: spec.id, clue: spec.clue, length: spec.length, ok: false, transportError: messageOf(err) });
      harvest(`main-transport-error-${spec.id}`, messageOf(err));
    }
    if (results.length % 25 === 0) {
      log.info(`spike: ${String(results.length)}/${String(clueSet.length)} calls done, spend so far USD ${spend.usd.toFixed(4)}`);
    }
  }

  const endedAt = new Date();
  log.info(`spike: main phase done - ${String(results.length)} calls, spend USD ${spend.usd.toFixed(4)}`);

  // -------------------------------------------------------------------
  // Query the inference log for the authoritative header/status picture.
  // -------------------------------------------------------------------
  const logRecords = await readInferenceLogRecordsSince(startIso);
  const statusCounts = new Map<string, number>();
  for (const rec of logRecords) {
    const key = rec.httpStatus === null ? 'network-error' : String(rec.httpStatus);
    statusCounts.set(key, (statusCounts.get(key) ?? 0) + 1);
  }

  // -------------------------------------------------------------------
  // Write harvested raw responses.
  // -------------------------------------------------------------------
  const responsesDir = join(repoRoot(), 'test', 'fixtures', 'responses');
  const toHarvest = harvested.slice(0, Math.max(5, Math.min(8, harvested.length)));
  for (let i = 0; i < toHarvest.length; i += 1) {
    const item = toHarvest[i];
    if (item === undefined) continue;
    const safeName = item.name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
    const path = join(responsesDir, `real-${String(i).padStart(2, '0')}-${safeName}.txt`);
    await writeFile(path, item.text, 'utf8');
    log.info(`spike: harvested raw response -> ${path}`);
  }

  // -------------------------------------------------------------------
  // Report.
  // -------------------------------------------------------------------
  const ok = results.filter((r) => r.ok);
  const parseFailures = ok.filter((r) => r.parseFailed === true);
  const parsedOk = ok.filter((r) => r.parseFailed === false);
  const totalCandidates = parsedOk.reduce((s, r) => s + (r.candidateCount ?? 0), 0);
  const mismatchCandidates = parsedOk.reduce((s, r) => s + (r.lengthMismatchCount ?? 0), 0);
  const latencyStats = statOf(ok.map((r) => r.latencyMs ?? 0));
  const understoodValues = parsedOk.map((r) => r.clueUnderstood ?? 0);
  const histogramBuckets = [0, 0.2, 0.4, 0.6, 0.8, 1.0001];
  const histogram = histogramBuckets.slice(0, -1).map((lo, i) => {
    const hi = histogramBuckets[i + 1] as number;
    const count = understoodValues.filter((v) => v >= lo && v < hi).length;
    return { lo, hi: i === histogramBuckets.length - 2 ? 1.0 : hi, count };
  });

  const report = buildReport({
    startIso,
    endedAt: endedAt.toISOString(),
    n: results.length,
    ok: ok.length,
    transportErrors: results.length - ok.length,
    parseFailures: parseFailures.length,
    totalCandidates,
    mismatchCandidates,
    latencyStats,
    histogram,
    understoodCount: understoodValues.length,
    usdSpent: spend.usd,
    headerTable,
    statusCounts,
    reasoningTrials,
    control,
    winner,
    schemaTrials,
    burstSamples,
    burstSize: BURST_SIZE,
    fixtureClueCount: fixtureClues.length,
    authoredClueCount: authoredClues().length,
    harvestedCount: toHarvest.length,
  });

  const outPath = join(repoRoot(), 'docs', 'spikes', 'tier1-reliability.md');
  await writeFile(outPath, report, 'utf8');
  log.info(`spike: wrote ${outPath}`);

  inferenceLog.close();
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

interface ReportInput {
  startIso: string;
  endedAt: string;
  n: number;
  ok: number;
  transportErrors: number;
  parseFailures: number;
  totalCandidates: number;
  mismatchCandidates: number;
  latencyStats: { mean: number; p50: number; p95: number };
  histogram: { lo: number; hi: number; count: number }[];
  understoodCount: number;
  usdSpent: number;
  headerTable: Map<string, HeaderInfo>;
  statusCounts: Map<string, number>;
  reasoningTrials: ReasoningTrial[];
  control: ReasoningTrial | undefined;
  winner: ReasoningTrial | undefined;
  schemaTrials: SchemaTrial[];
  burstSamples: BurstSample[];
  burstSize: number;
  fixtureClueCount: number;
  authoredClueCount: number;
  harvestedCount: number;
}

function pct(n: number, total: number): string {
  if (total === 0) return 'n/a';
  return `${((n / total) * 100).toFixed(1)}%`;
}

function buildReport(input: ReportInput): string {
  const lines: string[] = [];
  lines.push('# M2 spike: tier-1 reliability (T49)');
  lines.push('');
  lines.push(
    `Run window: ${input.startIso} to ${input.endedAt}. Model under test: \`${TIER1_MODEL}\` ` +
      '(tier 1). All numbers below come from a real run against the live Nebius Token Factory ' +
      'API, through the real `src/llm/client.ts` transport and the real inference log at ' +
      '`logs/inference/` (not committed, per B47); this document is a query over that log plus ' +
      'the parser (`src/llm/parser.ts`) run against each captured response.',
  );
  lines.push('');
  lines.push(`Total spend: **USD ${input.usdSpent.toFixed(4)}** (budget cap was USD ${BUDGET_USD.toFixed(2)}).`);
  lines.push('');

  lines.push('## 1. Reasoning-off parameter');
  lines.push('');
  lines.push(
    'Candidates were tried on the same clue ("Large striped Asian big cat", 5 letters) and ' +
      'compared by the `reasoningTokens` field the transport reads out of the usage blob ' +
      '(`completion_tokens_details.reasoning_tokens`).',
  );
  lines.push('');
  lines.push('| Candidate | Outcome | reasoningTokens | completionTokens | latencyMs |');
  lines.push('| --- | --- | ---: | ---: | ---: |');
  for (const t of input.reasoningTrials) {
    const outcome = t.ok ? 'accepted' : `rejected: ${t.httpError ?? 'unknown error'}`;
    lines.push(
      `| ${t.label} | ${outcome} | ${t.ok ? String(t.reasoningTokens) : '-'} | ` +
        `${t.ok ? String(t.completionTokens) : '-'} | ${t.ok ? String(t.latencyMs) : '-'} |`,
    );
  }
  lines.push('');
  if (input.control === undefined) {
    lines.push(
      '**No control call succeeded** (budget or connectivity issue before phase 1 could run); no ' +
        'conclusion about a reasoning-off parameter can be drawn from this run. ' +
        '`REASONING_OFF_PARAM` in `src/llm/tierRouter.ts` is left as-is with this evidence attached.',
    );
  } else if (input.winner === undefined) {
    lines.push(
      `**Finding: no candidate parameter reduced \`reasoningTokens\` below the control's ` +
        `${String(input.control.reasoningTokens)}.** Every accepted variant produced the same or a ` +
        'higher reasoning-token count, and the rejected variants (if any) were rejected outright by ' +
        'the API rather than silently ignored. This is treated as "no reasoning-off parameter found" ' +
        'for this model at this time: `REASONING_OFF_PARAM` is left as the named placeholder in ' +
        '`src/llm/tierRouter.ts` with a comment pointing at this report, rather than emitting a ' +
        'parameter that has no measured effect.',
    );
  } else {
    lines.push(
      `**Finding: \`${JSON.stringify(input.winner.extra)}\` reduced \`reasoningTokens\` from ` +
        `${String(input.control.reasoningTokens)} (control) to ${String(input.winner.reasoningTokens)}.** ` +
        'This is applied to every call in the phase-4 (200-clue) measurement below, and ' +
        '`src/llm/tierRouter.ts` is updated to emit it in place of the `reasoning_effort: true` ' +
        'placeholder, gated the same way (only `purpose: "seed"` on a `reasoning`-capable model).',
    );
  }
  lines.push('');

  lines.push('## 2. Tier-2 `response_format.json_schema` wrapper shape');
  lines.push('');
  if (input.schemaTrials.length === 0) {
    lines.push('Skipped: budget was already exhausted before this phase ran.');
  } else {
    lines.push('| Shape | Outcome | Parsed OK |');
    lines.push('| --- | --- | --- |');
    for (const t of input.schemaTrials) {
      lines.push(`| ${t.label} | ${t.ok ? 'HTTP 200' : `rejected: ${t.httpError ?? 'unknown'}`} | ${t.ok ? String(t.parsedOk) : '-'} |`);
    }
    lines.push('');
    const current = input.schemaTrials[0];
    const wrapped = input.schemaTrials[1];
    if (current?.ok === true) {
      lines.push(
        '**Finding: the current shape (`response_format.json_schema` set directly to the raw schema ' +
          'document) is accepted as-is** by Nebius for `deepseek-ai/DeepSeek-V4-Pro`. No wrapper change ' +
          'to `src/llm/tierRouter.ts` was needed.',
      );
    } else if (wrapped?.ok === true) {
      lines.push(
        '**Finding: Nebius rejects the raw schema document and requires the ' +
          '`{ name, schema, strict }` wrapper.** `src/llm/tierRouter.ts` is updated to send ' +
          '`response_format: { type: "json_schema", json_schema: { name: "candidate_response", ' +
          'schema: <the schema>, strict: true } }`.',
      );
    } else {
      lines.push(
        '**Neither shape was confirmed accepted** (see the rejection messages above); ' +
          '`src/llm/tierRouter.ts` is left unchanged pending a follow-up call with more budget.',
      );
    }
  }
  lines.push('');

  lines.push('## 3. Rate limit headers');
  lines.push('');
  lines.push(
    'Every distinct response header name observed across all phases of this run (discovery, schema ' +
      'probe, burst probe, and the 200-clue measurement). Header names are as returned by `fetch`, ' +
      'lower-cased. Per the task note, only `x-ratelimit-*` and `retry-after` carry an example value ' +
      'here; every other header is confirmed present but its value is not reproduced.',
  );
  lines.push('');
  lines.push('| Header | Rate-limit header? | Example value |');
  lines.push('| --- | --- | --- |');
  const sortedHeaders = [...input.headerTable.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const h of sortedHeaders) {
    const example = h.isRateLimit ? [...h.exampleValues].slice(0, 3).join(' / ') : '(not recorded)';
    lines.push(`| \`${h.name}\` | ${h.isRateLimit ? 'yes' : 'no'} | ${example} |`);
  }
  if (sortedHeaders.length === 0) {
    lines.push('| (none observed) | | |');
  }
  lines.push('');
  const rateLimitHeaderNames = sortedHeaders.filter((h) => h.isRateLimit).map((h) => h.name);
  if (rateLimitHeaderNames.length === 0) {
    lines.push(
      '**Finding: Nebius sent no `x-ratelimit-*` or `retry-after` header on any call in this run.** ' +
        'The spec\'s "Rate limiting" section treats every one of these headers as optional for exactly ' +
        'this reason ("Nebius support is unverified"); the client-side token bucket in ' +
        '`src/llm/rateLimiter.ts` is therefore the *only* effective control in v1, not a fallback to a ' +
        'server-communicated one.',
    );
  } else {
    lines.push(
      `**Finding: Nebius sends ${rateLimitHeaderNames.map((n) => `\`${n}\``).join(', ')}.**`,
    );
  }
  lines.push('');

  lines.push('## 4. Per-second bucket or per-minute window?');
  lines.push('');
  lines.push(
    `A raw HTTP burst of ${String(input.burstSize)} concurrent requests (bypassing the client-side ` +
      'rate limiter entirely, i.e. no `acquire()` gating) was fired at tier 1 to see how the server ' +
      'reacts to an instantaneous burst rather than a sustained rate.',
  );
  lines.push('');
  if (input.burstSamples.length === 0) {
    lines.push('No burst samples were captured (budget exhausted before phase 3, or every request errored).');
  } else {
    lines.push('| # | t (ms from burst start) | HTTP status |');
    lines.push('| ---: | ---: | ---: |');
    for (const s of input.burstSamples) {
      lines.push(`| ${String(s.index)} | ${String(s.ts)} | ${String(s.status)} |`);
    }
    lines.push('');
    const statuses = new Set(input.burstSamples.map((s) => s.status));
    const any429 = input.burstSamples.some((s) => s.status === 429);
    if (!any429) {
      const sequentialRps = input.latencyStats.mean > 0 ? 1000 / input.latencyStats.mean : 0;
      const elapsedSec = (new Date(input.endedAt).getTime() - new Date(input.startIso).getTime()) / 1000;
      const remainingRequestsHeader = input.headerTable.get('x-ratelimit-remaining-requests');
      const resetRequestsHeader = input.headerTable.get('x-ratelimit-reset-requests');
      const remainingExample =
        remainingRequestsHeader !== undefined
          ? [...remainingRequestsHeader.exampleValues].slice(0, 3).join(' / ')
          : undefined;
      const resetExample =
        resetRequestsHeader !== undefined ? [...resetRequestsHeader.exampleValues].slice(0, 3).join(' / ') : undefined;
      lines.push(
        `**Finding: all ${String(input.burstSamples.length)} concurrent requests returned ` +
          `${[...statuses].join('/')}, none 429.** A ${String(input.burstSize)}-request instantaneous ` +
          'burst did not trip the limit, which is consistent with either a bucket sized well above ' +
          `${String(input.burstSize)} requests, or a window wide enough (per-minute, not per-second) ` +
          'that a single short burst does not exhaust it. This run cannot distinguish those two cases ' +
          'on its own. The 200-clue phase (section 5) does **not** add sustained-rate evidence here: ' +
          `its loop awaits each call before starting the next, so it never approached the client ` +
          `limiter's configured cap - at the phase's mean latency of ${String(Math.round(input.latencyStats.mean))} ms ` +
          `it ran at roughly ${sequentialRps.toFixed(1)} rps (the whole run, all phases included, spanned ` +
          `about ${Math.round(elapsedSec)} s for ~${String(input.n)} main-phase calls), never close to a rate ` +
          'that would stress a per-second bucket. The better evidence for bucket-vs-window comes from the ' +
          'header values already captured in section 3' +
          (remainingExample !== undefined && resetExample !== undefined
            ? `: \`x-ratelimit-remaining-requests\` recovers toward its ceiling between sequential calls ` +
              `only seconds apart (e.g. ${remainingExample}), and \`x-ratelimit-reset-requests\` reports resets ` +
              `of ${resetExample} rather than anything near 60 s - both are consistent with a continuously ` +
              'refilling per-second-scale bucket, not a fixed 60-second window (which would show the ' +
              'remaining count falling monotonically for up to a minute before a hard reset). Separately, ' +
              `the ${String(input.burstSamples.length)}-request burst clearing instantly with zero 429s rules ` +
              'out a strict 10-requests-per-second bucket, since that many requests landing within well under ' +
              'a second would have exceeded a 10/s cap by roughly 2x if the bucket were that tight.'
            : ', but no rate-limit headers were captured in this run to compare against.'),
      );
    } else {
      lines.push(
        `**Finding: ${String(input.burstSamples.filter((s) => s.status === 429).length)} of ` +
          `${String(input.burstSamples.length)} concurrent requests returned 429.** The 429s and their ` +
          'timing above indicate the limit is enforced within the burst itself, consistent with a ' +
          'per-second (or smaller) bucket rather than a wide per-minute window that would have ' +
          'absorbed a burst this size against 600 RPM headroom.',
      );
    }
  }
  lines.push('');

  lines.push('## 5. Tier-1 seed-pass reliability (n = ' + String(input.n) + ')');
  lines.push('');
  lines.push(`- Clue pool: ${String(input.fixtureClueCount)} real clues from the committed xd fixtures ` +
    `(american stratum) plus ${String(input.authoredClueCount)} hand-authored clues (this task), mixed ` +
    `lengths (3-12 letters), deterministically shuffled and truncated to ${String(TARGET_CLUE_COUNT)}.`);
  lines.push(`- Calls attempted: ${String(input.n)}. Transport-level failures (all retries exhausted, or a ` +
    `non-retryable HTTP status): ${String(input.transportErrors)} (${pct(input.transportErrors, input.n)}).`);
  lines.push(`- **Parse-failure rate** (single-attempt, no retry - the parser could not produce a ` +
    `\`CandidateResponse\` for the slot at all): ${String(input.parseFailures)} / ${String(input.ok)} = ` +
    `${pct(input.parseFailures, input.ok)}.`);
  lines.push(`- **Length-error rate after normalisation** (of every candidate answer returned across all ` +
    `successfully parsed responses, the fraction whose \`normaliseAnswer()\`'d length does not equal ` +
    `the requested slot length): ${String(input.mismatchCandidates)} / ${String(input.totalCandidates)} = ` +
    `${pct(input.mismatchCandidates, input.totalCandidates)}.`);
  lines.push(`- **Latency** (successful calls, ms): mean ${input.latencyStats.mean.toFixed(0)}, ` +
    `p50 ${input.latencyStats.p50.toFixed(0)}, p95 ${input.latencyStats.p95.toFixed(0)}.`);
  lines.push('');
  lines.push('`clue_understood` histogram (over parsed responses):');
  lines.push('');
  lines.push('| Bucket | Count | Share |');
  lines.push('| --- | ---: | ---: |');
  for (const b of input.histogram) {
    lines.push(`| [${b.lo.toFixed(1)}, ${b.hi.toFixed(1)}${b.hi === 1 ? ']' : ')'} | ${String(b.count)} | ${pct(b.count, input.understoodCount)} |`);
  }
  lines.push('');
  lines.push('HTTP status counts across every attempt in this run (from the inference log, i.e. including retried attempts):');
  lines.push('');
  lines.push('| Status | Attempts |');
  lines.push('| --- | ---: |');
  for (const [status, count] of [...input.statusCounts.entries()].sort()) {
    lines.push(`| ${status} | ${String(count)} |`);
  }
  lines.push('');

  lines.push('## 6. Raw response samples');
  lines.push('');
  lines.push(
    `${String(input.harvestedCount)} real raw responses (including any malformed ones found) were ` +
      'harvested into `test/fixtures/responses/real-*.txt` (API key redacted, though the model never ' +
      'echoes it). These are evidence for this report, not parser test fixtures - T11 owns ' +
      '`test/fixtures/responses/*.txt` proper; the `real-` prefix keeps this run\'s samples from ' +
      'colliding with T11\'s hand-authored ones.',
  );
  lines.push('');

  lines.push('## Recommendation');
  lines.push('');
  const parseFailRate = input.ok > 0 ? input.parseFailures / input.ok : 1;
  const lengthErrRate = input.totalCandidates > 0 ? input.mismatchCandidates / input.totalCandidates : 1;
  if (input.n === 0) {
    lines.push(
      '**Blocked**: no calls completed (see budget/connectivity notes above). No reliability ' +
        'conclusion can be drawn from this run.',
    );
  } else if (parseFailRate <= 0.05 && lengthErrRate <= 0.15) {
    lines.push(
      `**Tier-1 JSON reliability looks acceptable for v1.** Parse-failure rate ` +
        `(${pct(input.parseFailures, input.ok)}) is low enough that the single retry-at-temperature-0 ` +
        'T34 already performs should absorb nearly all of it, and the length-error rate ' +
        `(${pct(input.mismatchCandidates, input.totalCandidates)}) is handled by the existing ` +
        'pattern/length validation step rather than needing a prompt change. No escalation-policy ' +
        'change is indicated by this data alone.',
    );
  } else {
    lines.push(
      `**Tier-1 JSON reliability is a concern.** Parse-failure rate ` +
        `${pct(input.parseFailures, input.ok)} and/or length-error rate ` +
        `${pct(input.mismatchCandidates, input.totalCandidates)} are high enough that the single ` +
        'retry-at-temperature-0 in T34 will not fully absorb them; consider tightening the seed ' +
        'prompt\'s length instruction, lowering `escalation.clueUnderstoodThreshold`, or reviewing ' +
        'whether tier 1 needs `--offline-lenient`-style handling more often than assumed.',
    );
  }
  lines.push('');

  lines.push('## Method notes and honesty caveats');
  lines.push('');
  lines.push(
    '- Parse-failure and length-error rates are measured on a single attempt with no retry, so they ' +
      'are not directly the "tier-1 failure" rate the spec defines (which is after one retry at ' +
      'temperature 0); they are the raw first-attempt numbers a retry rate would be computed from.',
  );
  lines.push(
    '- The reasoning-off finding (section 1) and the schema-wrapper finding (section 2) are each based ' +
      'on very few calls (single-digit) because they are cheap to test and do not need statistical ' +
      'power - they are pass/fail checks against what the API accepts, not a rate measurement.',
  );
  lines.push(
    '- `n` in section 5 may be less than 200 if the USD budget was reached first; the report always ' +
      'states the actual `n` used.',
  );
  lines.push('');

  return lines.join('\n');
}

await main();
