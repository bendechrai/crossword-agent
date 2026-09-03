import { describe, expect, it } from 'vitest';

import { NotImplementedError } from '../../src/util/errors.js';

/**
 * Acceptance 6: every stub module, when called, throws NotImplemented with its
 * own file path in the message.
 *
 * The check is generic rather than a hand-written call per export: for each
 * module below, every exported function is called (or constructed), and every
 * exported object's methods are called. A module that grows a real
 * implementation simply drops out of this list when its task lands.
 */
const STUB_MODULES: Array<[string, () => Promise<unknown>]> = [
  ['src/candidates/cache.ts', () => import('../../src/candidates/cache.js')],
  ['src/candidates/service.ts', () => import('../../src/candidates/service.js')],
  ['src/config.ts', () => import('../../src/config.js')],
  ['src/eval/aggregate.ts', () => import('../../src/eval/aggregate.js')],
  ['src/eval/inference.ts', () => import('../../src/eval/inference.js')],
  ['src/eval/runRecorder.ts', () => import('../../src/eval/runRecorder.js')],
  ['src/eval/scorer.ts', () => import('../../src/eval/scorer.js')],
  ['src/events/bus.ts', () => import('../../src/events/bus.js')],
  ['src/grid/domainStore.ts', () => import('../../src/grid/domainStore.js')],
  ['src/grid/model.ts', () => import('../../src/grid/model.js')],
  ['src/grid/pattern.ts', () => import('../../src/grid/pattern.js')],
  ['src/llm/client.ts', () => import('../../src/llm/client.js')],
  ['src/llm/inferenceLog.ts', () => import('../../src/llm/inferenceLog.js')],
  ['src/llm/parser.ts', () => import('../../src/llm/parser.js')],
  ['src/llm/pricing.ts', () => import('../../src/llm/pricing.js')],
  ['src/llm/prompts.ts', () => import('../../src/llm/prompts.js')],
  ['src/llm/rateLimiter.ts', () => import('../../src/llm/rateLimiter.js')],
  ['src/llm/tierRouter.ts', () => import('../../src/llm/tierRouter.js')],
  ['src/policy/budget.ts', () => import('../../src/policy/budget.js')],
  ['src/policy/escalation.ts', () => import('../../src/policy/escalation.js')],
  ['src/profiles/builtins.ts', () => import('../../src/profiles/builtins.js')],
  ['src/profiles/loader.ts', () => import('../../src/profiles/loader.js')],
  ['src/puzzle/adapters/guardian.ts', () => import('../../src/puzzle/adapters/guardian.js')],
  ['src/puzzle/adapters/xd.ts', () => import('../../src/puzzle/adapters/xd.js')],
  ['src/puzzle/adapters/xwordly.ts', () => import('../../src/puzzle/adapters/xwordly.js')],
  ['src/puzzle/enumeration.ts', () => import('../../src/puzzle/enumeration.js')],
  ['src/puzzle/library.ts', () => import('../../src/puzzle/library.js')],
  ['src/puzzle/numbering.ts', () => import('../../src/puzzle/numbering.js')],
  ['src/render/console.ts', () => import('../../src/render/console.js')],
  ['src/render/jsonl.ts', () => import('../../src/render/jsonl.js')],
  ['src/render/replay.ts', () => import('../../src/render/replay.js')],
  ['src/render/watch.ts', () => import('../../src/render/watch.js')],
  ['src/score/calibrate.ts', () => import('../../src/score/calibrate.js')],
  ['src/solver/ac3.ts', () => import('../../src/solver/ac3.js')],
  ['src/solver/hooks.ts', () => import('../../src/solver/hooks.js')],
  ['src/solver/ordering.ts', () => import('../../src/solver/ordering.js')],
  ['src/solver/repair.ts', () => import('../../src/solver/repair.js')],
  ['src/solver/search.ts', () => import('../../src/solver/search.js')],
  ['src/solver/solve.ts', () => import('../../src/solver/solve.js')],
  ['src/sources/file.ts', () => import('../../src/sources/file.js')],
  ['src/sources/guardian.ts', () => import('../../src/sources/guardian.js')],
  ['src/sources/xd.ts', () => import('../../src/sources/xd.js')],
  ['src/util/git.ts', () => import('../../src/util/git.js')],
  ['src/validate/normalise.ts', () => import('../../src/validate/normalise.js')],
  ['src/validate/wordlist.ts', () => import('../../src/validate/wordlist.js')],
];

type Callable = (...args: unknown[]) => unknown;

function isCallable(value: unknown): value is Callable {
  return typeof value === 'function';
}

/** Calls a function, retrying with `new` for a class, and reports what threw. */
function invoke(fn: Callable): unknown {
  try {
    return fn();
  } catch (e) {
    if (e instanceof TypeError && /without 'new'|cannot be invoked/i.test(e.message)) {
      return Reflect.construct(fn, []);
    }
    throw e;
  }
}

async function callablesOf(load: () => Promise<unknown>): Promise<Array<[string, Callable]>> {
  const mod: unknown = await load();
  const out: Array<[string, Callable]> = [];
  for (const [name, value] of Object.entries(mod as Record<string, unknown>)) {
    if (isCallable(value)) {
      out.push([name, value]);
      continue;
    }
    if (typeof value === 'object' && value !== null) {
      for (const [method, member] of Object.entries(value as Record<string, unknown>)) {
        if (isCallable(member)) out.push([`${name}.${method}`, member.bind(value)]);
      }
    }
  }
  return out;
}

/**
 * A stub either throws when called, or - for the adapter factories, whose job
 * is to build an object the registry can hold without exploding at import
 * time - returns an object whose every method throws.
 */
async function assertStub(modulePath: string, name: string, fn: Callable): Promise<void> {
  let thrown: unknown;
  let returned: unknown;
  try {
    returned = invoke(fn);
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

  expect(
    typeof returned === 'object' && returned !== null,
    `${modulePath} ${name} neither threw nor returned an object of stubs`,
  ).toBe(true);
  const methods = Object.entries(returned as Record<string, unknown>).filter(([, v]) =>
    isCallable(v),
  );
  expect(methods.length, `${modulePath} ${name} returned an object with no methods`).toBeGreaterThan(
    0,
  );
  for (const [method, member] of methods) {
    await assertStub(modulePath, `${name}().${method}`, (member as Callable).bind(returned));
  }
}

describe.each(STUB_MODULES)('%s', (modulePath, load) => {
  it('throws NotImplementedError naming its own file', async () => {
    const callables = await callablesOf(load);
    expect(callables.length, `${modulePath} exports nothing callable`).toBeGreaterThan(0);
    for (const [name, fn] of callables) {
      await assertStub(modulePath, name, fn);
    }
  });
});
