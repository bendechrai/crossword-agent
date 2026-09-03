import { notImplemented } from '../util/errors.js';
import type { CandidateService } from '../candidates/types.js';
import type { Emit } from '../events/types.js';
import type { DomainStore } from '../grid/types.js';
import type { Grid } from '../grid/model.js';
import type { Profile } from '../profiles/schema.js';
import type { BudgetTracker } from '../policy/budget.js';
import type { SearchHooks } from './types.js';

export interface SearchHooksDeps {
  grid: Grid;
  domains: DomainStore;
  service: CandidateService;
  budget: BudgetTracker;
  profile: Profile;
  emit: Emit;
}

/**
 * T38: the implementation of the interface T37 calls. Applies the re-ask
 * guards, merges results into the base domain (B39), consults `decide()` after
 * every service return, routes escalations to tier 2, and charges the budget.
 */
export function createSearchHooks(_deps: SearchHooksDeps): SearchHooks {
  return notImplemented('src/solver/hooks.ts');
}
