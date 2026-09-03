import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { NotImplementedError } from '../../src/util/errors.js';

/**
 * Data-driven: a module stops being a stub the moment it no longer throws
 * NotImplementedError. Builders implement their module and this test
 * adapts; do not add a list here.
 *
 * Every stub body in this repository throws via the shared `notImplemented`
 * helper (src/util/errors.ts), naming its own file. So a module is found to
 * be a stub by scanning src/**\/*.ts (excluding *.d.ts) for source text that
 * calls that helper - `notImplemented(` - rather than by a hand-maintained
 * list. The helper's own definition file is excluded, since it declares the
 * call rather than being a stub itself. A file drops out of this scan (and
 * this test stops checking it) the moment a builder removes its last call to
 * the helper, i.e. finishes implementing it.
 *
 * For each stub module found, every exported function is called with no
 * arguments, and every method of every exported class's prototype is called
 * on an instance constructed with no arguments (skipped if construction
 * itself throws something other than NotImplementedError, since supplying a
 * fully-formed dependency graph is not this test's job). Each is asserted to
 * throw NotImplementedError naming the module.
 */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC_ROOT = join(REPO_ROOT, 'src');
const STUB_CALL = 'notImplemented(';
const STUB_HELPER_DECLARATION = 'export function notImplemented';

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      out.push(...listTsFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

function findStubModules(): string[] {
  const stubs: string[] = [];
  for (const file of listTsFiles(SRC_ROOT)) {
    const text = readFileSync(file, 'utf8');
    if (text.includes(STUB_CALL) && !text.includes(STUB_HELPER_DECLARATION)) {
      stubs.push(relative(REPO_ROOT, file));
    }
  }
  return stubs.sort();
}

/** repo-relative 'src/a/b.ts' -> the '../../src/a/b.js' specifier this test file imports by. */
function toImportSpecifier(modulePath: string): string {
  return `../../${modulePath.replace(/\.ts$/, '.js')}`;
}

const STUB_MODULES: Array<[string, () => Promise<unknown>]> = findStubModules().map(
  (modulePath) => [modulePath, () => import(toImportSpecifier(modulePath))],
);

type Callable = (...args: unknown[]) => unknown;

function isClass(value: unknown): value is new (...args: unknown[]) => unknown {
  if (typeof value !== 'function') return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'prototype');
  return descriptor !== undefined && descriptor.writable === false;
}

function isCallable(value: unknown): value is Callable {
  return typeof value === 'function' && !isClass(value);
}

/** Calls `fn` (optionally bound to `thisArg`) and asserts it throws NotImplementedError naming `modulePath`. */
async function assertThrowsNotImplemented(
  modulePath: string,
  name: string,
  fn: Callable,
  thisArg?: unknown,
): Promise<void> {
  let thrown: unknown;
  let returned: unknown;
  try {
    returned = thisArg === undefined ? fn() : fn.call(thisArg);
    // Some stubs return the rejected promise rather than throwing.
    if (returned instanceof Promise) await returned;
  } catch (e) {
    thrown = e;
  }

  if (thrown !== undefined) {
    expect(thrown, `${modulePath} ${name} threw the wrong error`).toBeInstanceOf(
      NotImplementedError,
    );
    expect((thrown as NotImplementedError).message).toContain(modulePath);
    return;
  }

  // Some stub factories, rather than throwing directly, return an object
  // whose own methods are themselves stubs.
  expect(
    typeof returned === 'object' && returned !== null,
    `${modulePath} ${name} neither threw nor returned an object of stubs`,
  ).toBe(true);
  const methods = Object.entries(returned as Record<string, unknown>).filter(([, v]) =>
    isCallable(v),
  );
  expect(
    methods.length,
    `${modulePath} ${name} returned an object with no methods`,
  ).toBeGreaterThan(0);
  for (const [method, member] of methods) {
    await assertThrowsNotImplemented(
      modulePath,
      `${name}().${method}`,
      (member as Callable).bind(returned),
    );
  }
}

/**
 * Constructs `Cls` with no arguments and checks every method on its
 * prototype. If construction itself throws NotImplementedError, that is the
 * stub and there is nothing further to check. If construction throws
 * anything else - a real constructor demanding real dependencies - this
 * class is skipped rather than failed.
 */
async function assertClassIsStub(modulePath: string, name: string, Cls: unknown): Promise<void> {
  const Ctor = Cls as new (...args: unknown[]) => unknown;
  let instance: unknown;
  try {
    instance = new Ctor();
  } catch (e) {
    if (e instanceof NotImplementedError) {
      expect(e.message).toContain(modulePath);
      return;
    }
    return;
  }

  const instanceRecord = instance as Record<string, unknown>;
  for (const methodName of Object.getOwnPropertyNames(Ctor.prototype)) {
    if (methodName === 'constructor') continue;
    const member = instanceRecord[methodName];
    if (!isCallable(member)) continue;
    await assertThrowsNotImplemented(
      modulePath,
      `${name}.prototype.${methodName}`,
      member,
      instance,
    );
  }
}

async function checkModule(modulePath: string, load: () => Promise<unknown>): Promise<void> {
  const mod = (await load()) as Record<string, unknown>;
  const exportNames = Object.keys(mod);
  expect(exportNames.length, `${modulePath} exports nothing`).toBeGreaterThan(0);

  for (const [name, value] of Object.entries(mod)) {
    if (isClass(value)) {
      await assertClassIsStub(modulePath, name, value);
    } else if (isCallable(value)) {
      await assertThrowsNotImplemented(modulePath, name, value);
    }
    // Non-callable exports (types, plain constants) are not stubs to check.
  }
}

describe.each(STUB_MODULES)('%s', (modulePath, load) => {
  it('throws NotImplementedError naming its own file', async () => {
    await checkModule(modulePath, load);
  });
});

// describe.each registers zero suites when STUB_MODULES is empty, and
// vitest 4 fails a file outright with "No test suite found" if it ends up
// with no tests at all. Once every src module has been implemented and the
// scan above comes back empty, register this single passing test instead so
// the file always contains at least one test.
if (STUB_MODULES.length === 0) {
  it('no stub modules remain (every src module is implemented)', () => {
    expect(STUB_MODULES).toEqual([]);
  });
}
