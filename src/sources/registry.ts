import { usageError } from '../cli/exit.js';
import { fileSource } from './file.js';
import { guardianSource } from './guardian.js';
import { xdSource } from './xd.js';
import type { SourceAdapter } from './types.js';

const registry = new Map<string, SourceAdapter>();

export function registerSource(adapter: SourceAdapter): void {
  registry.set(adapter.id, adapter);
}

export function hasSource(id: string): boolean {
  return registry.has(id);
}

export function listSourceIds(): string[] {
  return [...registry.keys()].sort();
}

export function getSource(id: string): SourceAdapter {
  const adapter = registry.get(id);
  if (adapter === undefined) {
    throw usageError(`unknown source "${id}"`, `known sources: ${listSourceIds().join(', ')}`);
  }
  return adapter;
}

/** Test seam: drop everything, then re-register the built-ins. */
export function resetSources(): void {
  registry.clear();
  registerBuiltinSources();
}

export function registerBuiltinSources(): void {
  registerSource(guardianSource);
  registerSource(xdSource);
  registerSource(fileSource);
}

registerBuiltinSources();
