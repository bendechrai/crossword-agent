import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchemaObject } from 'ajv/dist/2020.js';
// ajv-formats is CommonJS with only a default export, which from an ES module
// arrives as the namespace's `default`; TypeScript models that as the module
// type rather than the callable, hence the cast to its own exported type.
import * as ajvFormatsModule from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';

import { CliError, ExitCode, notFoundError } from '../cli/exit.js';
import { atomicWriteFile, ensureDir, repoRoot, resolvePuzzlesDir } from '../util/fs.js';
import type {
  NormalisedPuzzleFile,
  Puzzle,
  PuzzleIndexRow,
  PuzzleWithSolution,
} from './types.js';

const addFormats = ajvFormatsModule.default as unknown as FormatsPlugin;

export interface LibraryOptions {
  /** Defaults to `resolvePuzzlesDir()`. */
  puzzlesDir?: string;
}

function puzzlesDirOf(opts?: LibraryOptions): string {
  return opts?.puzzlesDir ?? resolvePuzzlesDir();
}

// --------------------------------------------------------------------------
// Schema validation. Both schemas are loaded and compiled once, lazily, the
// first time either is needed.
// --------------------------------------------------------------------------

/** Only the parts of a schema file this module needs to build a $ref schema from it. */
interface SchemaDefsFile {
  $schema: string;
  $defs: Record<string, unknown>;
}

function readSchema(name: string): AnySchemaObject {
  const path = join(repoRoot(), 'schemas', name);
  return JSON.parse(readFileSync(path, 'utf8')) as AnySchemaObject;
}

function buildValidators() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  // schemas/puzzle-index.schema.json describes the whole file - an array of
  // rows - so a single row is validated against its `#/$defs/row` def rather
  // than against the top-level (array) schema.
  const indexSchemaFile = readSchema('puzzle-index.schema.json') as unknown as SchemaDefsFile;
  return {
    ajv,
    puzzleFile: ajv.compile<NormalisedPuzzleFile>(readSchema('puzzle.schema.json')),
    indexRow: ajv.compile<PuzzleIndexRow>({
      $schema: indexSchemaFile.$schema,
      $defs: indexSchemaFile.$defs,
      $ref: '#/$defs/row',
    } as AnySchemaObject),
  };
}

type Validators = ReturnType<typeof buildValidators>;

let cachedValidators: Validators | null = null;

function validators(): Validators {
  cachedValidators ??= buildValidators();
  return cachedValidators;
}

/** Validates a candidate normalised puzzle file against schemas/puzzle.schema.json (B16). */
function assertValidPuzzleFile(
  data: unknown,
  context: string,
): asserts data is NormalisedPuzzleFile {
  const { ajv, puzzleFile } = validators();
  if (!puzzleFile(data)) {
    throw new Error(
      `${context} failed schemas/puzzle.schema.json validation: ${ajv.errorsText(puzzleFile.errors)}`,
    );
  }
}

/** Validates a candidate puzzles/index.json row against schemas/puzzle-index.schema.json (B34). */
function assertValidIndexRow(row: PuzzleIndexRow): void {
  const { ajv, indexRow } = validators();
  if (!indexRow(row)) {
    throw new Error(
      `puzzle index row "${row.id}" failed schemas/puzzle-index.schema.json validation: ${ajv.errorsText(indexRow.errors)}`,
    );
  }
}

// --------------------------------------------------------------------------
// Normalised puzzle files: puzzles/<source>/<id>.json
// --------------------------------------------------------------------------

/** Writes `puzzles/<source>/<id>.json`, ajv-validated before the write (B16). */
export async function writeNormalised(
  puzzle: PuzzleWithSolution,
  opts?: LibraryOptions,
): Promise<NormalisedPuzzleFile> {
  const file: NormalisedPuzzleFile = {
    ...puzzle,
    schemaVersion: 1,
    fetchedAt: new Date().toISOString(),
  };
  assertValidPuzzleFile(file, `normalised puzzle "${puzzle.id}"`);

  const dir = puzzlesDirOf(opts);
  const path = join(dir, puzzle.source, `${puzzle.id}.json`);
  await atomicWriteFile(path, `${JSON.stringify(file, null, 2)}\n`);
  return file;
}

/**
 * Finds `puzzles/<source>/<id>.json` for an id whose source is not given, by
 * scanning the source subdirectories of `puzzlesDir`. There is no reverse
 * index from id to source: `puzzles/index.json` is a separate concern (kept
 * up to date by whoever calls `upsertIndexRow`, not by this function), and
 * `readNormalised`/`loadPuzzleById`/`loadSolution` all work from the
 * normalised files alone so a puzzle can be read back before, or even
 * without, an index row existing for it.
 */
function findNormalisedPath(puzzlesDir: string, id: string): string | null {
  if (!existsSync(puzzlesDir)) return null;
  for (const entry of readdirSync(puzzlesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(puzzlesDir, entry.name, `${id}.json`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function readNormalised(
  id: string,
  opts?: LibraryOptions,
): Promise<NormalisedPuzzleFile> {
  const dir = puzzlesDirOf(opts);
  const path = findNormalisedPath(dir, id);
  if (path === null) {
    throw notFoundError(`no normalised puzzle found for id "${id}" under ${dir}`);
  }
  const raw = await readFile(path, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  assertValidPuzzleFile(parsed, `normalised puzzle at ${path}`);
  return parsed;
}

/**
 * The solver's accessor: the puzzle with the answers stripped (B11).
 *
 * Built field by field rather than by deleting `solution` off a copy, so the
 * key is never present at all - not even as `solution: undefined` - which is
 * what makes `"solution" in puzzle === false` true unconditionally.
 */
export async function loadPuzzleById(id: string, opts?: LibraryOptions): Promise<Puzzle> {
  const file = await readNormalised(id, opts);
  const puzzle: Puzzle = {
    id: file.id,
    source: file.source,
    style: file.style,
    width: file.width,
    height: file.height,
    cells: file.cells,
    slots: file.slots,
    parsedBy: file.parsedBy,
  };
  if (file.date !== undefined) puzzle.date = file.date;
  if (file.title !== undefined) puzzle.title = file.title;
  if (file.author !== undefined) puzzle.author = file.author;
  return puzzle;
}

/** The scorer's accessor. */
export async function loadSolution(id: string, opts?: LibraryOptions): Promise<string[][]> {
  const file = await readNormalised(id, opts);
  return file.solution;
}

// --------------------------------------------------------------------------
// puzzles/index.json, guarded by an O_EXCL lock file (B34).
// --------------------------------------------------------------------------

const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 20;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isEexist(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
  );
}

/**
 * Acquires `puzzles/.index.lock` by creating it with O_EXCL, polling until it
 * succeeds. A stale lock is not auto-removed in v1 (decision baked in): after
 * 5 seconds this throws a `CliError` (exit 1) naming the lock path and
 * telling the caller to delete it if no other process is running - that
 * message is the only remedy v1 offers.
 */
async function acquireIndexLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, 'wx'));
      return;
    } catch (error) {
      if (!isEexist(error)) throw error;
      if (Date.now() >= deadline) {
        throw new CliError(
          ExitCode.UNEXPECTED,
          `timed out after 5s waiting for the puzzle index lock at ${lockPath}; ` +
            `if no other process is running, delete ${lockPath} and try again`,
        );
      }
      await delay(LOCK_POLL_MS);
    }
  }
}

async function withIndexLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await acquireIndexLock(lockPath);
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone: nothing left to release.
    }
  }
}

async function readIndexFile(indexPath: string): Promise<PuzzleIndexRow[]> {
  if (!existsSync(indexPath)) return [];
  const raw = await readFile(indexPath, 'utf8');
  if (raw.trim().length === 0) return [];
  return JSON.parse(raw) as PuzzleIndexRow[];
}

/** `readIndex()` on a missing file returns `[]` (B33's empty case is the CLI's to render). */
export async function readIndex(opts?: LibraryOptions): Promise<PuzzleIndexRow[]> {
  const dir = puzzlesDirOf(opts);
  return readIndexFile(join(dir, 'index.json'));
}

/**
 * All index writes go through one writer, serialised by an O_EXCL lock file at
 * `puzzles/.index.lock` with a 5 second timeout, then an atomic tmp + rename
 * (B34). `bench` at concurrency 2 or more otherwise loses rows.
 *
 * The row is schema-validated before the lock is even acquired, so an
 * invalid row is rejected before any write - including the lock file itself.
 */
export async function upsertIndexRow(row: PuzzleIndexRow, opts?: LibraryOptions): Promise<void> {
  assertValidIndexRow(row);

  const dir = puzzlesDirOf(opts);
  ensureDir(dir);
  const indexPath = join(dir, 'index.json');
  const lockPath = join(dir, '.index.lock');

  await withIndexLock(lockPath, async () => {
    const rows = await readIndexFile(indexPath);
    const existingIndex = rows.findIndex((existing) => existing.id === row.id);
    if (existingIndex >= 0) {
      rows[existingIndex] = row;
    } else {
      rows.push(row);
    }
    await atomicWriteFile(indexPath, `${JSON.stringify(rows, null, 2)}\n`);
  });
}
