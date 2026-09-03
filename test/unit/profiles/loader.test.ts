import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ExitCode, isCliError } from '../../../src/cli/exit.js';
import type { CliError } from '../../../src/cli/exit.js';
import { loadConfig } from '../../../src/config.js';
import { baseline, patient, strongOnly } from '../../../src/profiles/builtins.js';
import { resolveProfile } from '../../../src/profiles/loader.js';
import { PROFILE_SOURCE_BUILTIN } from '../../../src/profiles/schema.js';
import type { ProfileInput } from '../../../src/profiles/schema.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/profiles');
const fixture = (name: string): string => join(FIXTURES_DIR, name);

async function expectCliError(fn: () => Promise<unknown>, code: ExitCode): Promise<CliError> {
  let error: unknown;
  try {
    await fn();
  } catch (e) {
    error = e;
  }
  expect(isCliError(error)).toBe(true);
  if (!isCliError(error)) throw new Error('expected a CliError');
  expect(error.code).toBe(code);
  return error;
}

describe('resolveProfile - built-in and file resolution', () => {
  it('resolves a bare built-in name with source "builtin"', async () => {
    const { profile, source } = await resolveProfile({ profile: 'strong-only' });
    expect(profile).toEqual(strongOnly);
    expect(source).toBe(PROFILE_SOURCE_BUILTIN);
  });

  it('defaults to "baseline" when no profile is named anywhere', async () => {
    const { profile, source } = await resolveProfile({});
    expect(profile).toEqual(baseline);
    expect(source).toBe(PROFILE_SOURCE_BUILTIN);
  });

  it('a profile file without "extends" is layered directly over zod defaults', async () => {
    const { profile, source } = await resolveProfile({ profile: fixture('full-profile.json') });
    expect(profile.name).toBe('custom-file-profile');
    expect(profile.tier1).toBe('acme/file-model');
    // Untouched fields fall through to the zod defaults, not to any builtin.
    expect(profile.candidatesPerAsk).toBe(10);
    expect(profile.sampling.temperature).toBe(0.2);
    expect(source).toBe(fixture('full-profile.json'));
  });

  it('"extends: patient" inherits reasksPerSlot 3 and overrides what it names (Acceptance 4)', async () => {
    const { profile } = await resolveProfile({ profile: fixture('extends-patient.json') });
    expect(profile.reasksPerSlot).toBe(3); // inherited from patient, unset by the file
    expect(profile.search.ldsLimitMax).toBe(7); // the field the file names
    // The rest of the *same* nested group is inherited, not reset to zod
    // defaults - a one-level-deep merge, not a group replacement.
    expect(profile.search.maxBacktracks).toBe(500);
    expect(profile.search.ordering).toBe('margin');
  });

  it('a file extending an unknown built-in is a usage error naming it', async () => {
    const error = await expectCliError(
      () => resolveProfile({ profile: fixture('extends-unknown-builtin.json') }),
      ExitCode.USAGE,
    );
    expect(error.message).toContain('not-a-real-builtin');
  });

  it('an unknown key in a profile file is a usage error naming the key (Acceptance 5)', async () => {
    const error = await expectCliError(
      () => resolveProfile({ profile: fixture('unknown-key.json') }),
      ExitCode.USAGE,
    );
    expect(error.message).toContain('toaster');
  });

  it('a typo inside a nested group of a profile file is a usage error naming "group.key"', async () => {
    const error = await expectCliError(
      () => resolveProfile({ profile: fixture('nested-unknown-key.json') }),
      ExitCode.USAGE,
    );
    expect(error.message).toContain('search.maxBactracks');
  });

  it('a profile spec that is neither a built-in nor an existing file is a usage error', async () => {
    await expectCliError(() => resolveProfile({ profile: 'no-such-profile-or-file' }), ExitCode.USAGE);
  });

  // A name that is an `Object.prototype` member is no more a profile than any
  // other unknown string: it must not resolve to an inherited member of the
  // built-in map on its way through `getBuiltin()`.
  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'a profile spec naming the Object.prototype member "%s" is an ordinary usage error',
    async (spec) => {
      await expectCliError(() => resolveProfile({ profile: spec }), ExitCode.USAGE);
    },
  );
});

describe('resolveProfile - five-layer precedence (Acceptance 3)', () => {
  // Each case below resolves the same field (tier1) through one more layer
  // than the last, each layer winning with its own distinct value.
  it('layer 1: zod defaults win when nothing else sets the field', async () => {
    const { profile } = await resolveProfile({ profile: fixture('full-profile-no-tier1.json') });
    expect(profile.tier1).toBe('nvidia/Nemotron-3_5-Lightning');
  });

  it('layer 2: a named built-in wins over the zod default', async () => {
    const { profile } = await resolveProfile({ profile: 'strong-only' });
    expect(profile.tier1).toBe('deepseek-ai/DeepSeek-V4-Pro');
  });

  it('layer 3: a profile file wins over the built-in it extends', async () => {
    const { profile } = await resolveProfile({
      profile: fixture('extends-strong-only-tier1-override.json'),
    });
    expect(profile.tier1).toBe('acme/file-model');
  });

  it('layer 4: config.defaultProfile wins over the hardcoded "baseline" fallback, but only when no --profile is given', async () => {
    const withConfig = await resolveProfile({ config: { defaultProfile: 'strong-only' } });
    expect(withConfig.profile.tier1).toBe('deepseek-ai/DeepSeek-V4-Pro');

    const withoutConfig = await resolveProfile({});
    expect(withoutConfig.profile.tier1).toBe('nvidia/Nemotron-3_5-Lightning');

    // An explicit --profile always wins over config.defaultProfile.
    const explicitWins = await resolveProfile({
      profile: 'baseline',
      config: { defaultProfile: 'strong-only' },
    });
    expect(explicitWins.profile.tier1).toBe('nvidia/Nemotron-3_5-Lightning');
  });

  it('layer 5: an explicit CLI override wins over everything below it', async () => {
    const { profile } = await resolveProfile({
      profile: 'strong-only',
      overrides: { tier1: 'cli-model' },
    });
    expect(profile.tier1).toBe('cli-model');
  });
});

describe('resolveProfile - CLI overrides merge nested groups one level deep', () => {
  it('overriding one sampling field keeps the other sampling fields', async () => {
    const { profile } = await resolveProfile({
      profile: 'patient',
      overrides: { sampling: { maxTokens: 999 } },
    });
    expect(profile.sampling.maxTokens).toBe(999);
    expect(profile.sampling.temperature).toBe(patient.sampling.temperature);
  });

  it('a "__proto__" key in an overrides object cannot inject a field through the prototype', async () => {
    // The base file deliberately leaves `tier1` unset, so a replaced prototype
    // would be the only place a `tier1` could come from: a plain
    // `out['__proto__'] = value` assignment in the overlay swaps the object's
    // prototype instead of adding a field, and the value below would then be
    // read in place of the zod default.
    const overrides = JSON.parse('{"__proto__":{"tier1":"polluted"}}') as Partial<ProfileInput>;
    const { profile } = await resolveProfile({
      profile: fixture('full-profile-no-tier1.json'),
      overrides,
    });
    expect(profile.tier1).toBe('nvidia/Nemotron-3_5-Lightning');
  });

  it('an explicit undefined inside a nested-group override never discards a value the base already set', async () => {
    // The natural shape T45 produces when mapping absent commander flags
    // into overrides: the key is present but its value is `undefined`. The
    // profile file sets sampling.maxTokens 1024; the override only means to
    // touch temperature, but spreading an `undefined` maxTokens verbatim
    // would clobber it back to the zod default (512).
    const { profile } = await resolveProfile({
      profile: fixture('sampling-max-tokens.json'),
      overrides: { sampling: { temperature: 0.5, maxTokens: undefined } },
    });
    expect(profile.sampling.temperature).toBe(0.5);
    expect(profile.sampling.maxTokens).toBe(1024);
  });
});

describe('loadConfig - four-source precedence and absence (Acceptance 6)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crossword-config-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is {} with a null path when no source is present', async () => {
    const result = await loadConfig({ cwd: dir, env: {} });
    expect(result).toEqual({ config: {}, path: null });
  });

  it('falls back to ./crossword.config.json when nothing more specific is given', async () => {
    const defaultPath = join(dir, 'crossword.config.json');
    await writeFile(defaultPath, JSON.stringify({ defaultProfile: 'patient' }));
    const result = await loadConfig({ cwd: dir, env: {} });
    expect(result).toEqual({ config: { defaultProfile: 'patient' }, path: defaultPath });
  });

  it('$CROSSWORD_CONFIG outranks the default filename', async () => {
    await writeFile(join(dir, 'crossword.config.json'), JSON.stringify({ defaultProfile: 'patient' }));
    const envPath = join(dir, 'env-config.json');
    await writeFile(envPath, JSON.stringify({ defaultProfile: 'no-repair' }));
    const result = await loadConfig({ cwd: dir, env: { CROSSWORD_CONFIG: envPath } });
    expect(result).toEqual({ config: { defaultProfile: 'no-repair' }, path: envPath });
  });

  it('--config outranks $CROSSWORD_CONFIG', async () => {
    const envPath = join(dir, 'env-config.json');
    await writeFile(envPath, JSON.stringify({ defaultProfile: 'no-repair' }));
    const flagPath = join(dir, 'flag-config.json');
    await writeFile(flagPath, JSON.stringify({ defaultProfile: 'tier1-only' }));
    const result = await loadConfig({ cwd: dir, env: { CROSSWORD_CONFIG: envPath }, path: flagPath });
    expect(result).toEqual({ config: { defaultProfile: 'tier1-only' }, path: flagPath });
  });

  it('an explicitly named config file that does not exist is a usage error', async () => {
    await expectCliError(
      () => loadConfig({ cwd: dir, env: {}, path: join(dir, 'missing.json') }),
      ExitCode.USAGE,
    );
  });

  it('an unknown key in the config file is a usage error naming it', async () => {
    const path = join(dir, 'crossword.config.json');
    await writeFile(path, JSON.stringify({ cachDir: 'typo' }));
    const error = await expectCliError(() => loadConfig({ cwd: dir, env: {} }), ExitCode.USAGE);
    expect(error.message).toContain('cachDir');
  });

  it('a defaultProfile naming a built-in loads without error', async () => {
    const path = join(dir, 'crossword.config.json');
    await writeFile(path, JSON.stringify({ defaultProfile: 'strong-only' }));
    const result = await loadConfig({ cwd: dir, env: {} });
    expect(result.config.defaultProfile).toBe('strong-only');
  });

  it('a defaultProfile naming an existing profile file (resolved against cwd) loads without error', async () => {
    const profilePath = join(dir, 'my-profile.json');
    await writeFile(profilePath, JSON.stringify({ name: 'my-profile' }));
    const path = join(dir, 'crossword.config.json');
    await writeFile(path, JSON.stringify({ defaultProfile: 'my-profile.json' }));
    const result = await loadConfig({ cwd: dir, env: {} });
    expect(result.config.defaultProfile).toBe('my-profile.json');
  });

  it('a defaultProfile naming neither a built-in nor an existing file is a load-time usage error (T23 decision)', async () => {
    const path = join(dir, 'crossword.config.json');
    await writeFile(path, JSON.stringify({ defaultProfile: 'no-such-profile' }));
    const error = await expectCliError(() => loadConfig({ cwd: dir, env: {} }), ExitCode.USAGE);
    expect(error.message).toContain('no-such-profile');
    expect(error.message).toContain(path);
  });
});

describe('src/config.ts never imports node:os (Acceptance 7)', () => {
  it('grep -c "homedir" is 0', async () => {
    const configSourcePath = join(dirname(fileURLToPath(import.meta.url)), '../../../src/config.ts');
    const text = await readFile(configSourcePath, 'utf8');
    const count = (text.match(/homedir/g) ?? []).length;
    expect(count).toBe(0);
  });
});
