# puzzles/fixtures/FIXTURES.md

Four hand-picked `.xd` puzzles from the public xd crossword corpus
(https://xd.saul.pw/, tooling by Saul Pwanson / century-arcade, MIT licensed),
plus this record of where each came from and the specific public-domain
basis claimed for it (A3, T48).

**This task is marked `needs-human-review`. The licence basis recorded below
is this task's best-effort research, not a legal conclusion. Ben's sign-off
is required before any of these files are treated as clear for
redistribution.**

## Corpus and selection

- Corpus: `https://xd.saul.pw/xd-puzzles.zip`, downloaded once (2026-09-03)
  into `corpora/xd-puzzles.zip` on the host side of the worktree (gitignored,
  not committed - B46/B47). Per `docs/crossword-sources.md`, this is the
  corpus's own publicly downloadable bulk archive; the site describes its
  license-clean slice as "over 6,000 pre-1965 New York Times crossword
  puzzles" (the rest of the archive's contents are the private/copyrighted
  `gxd` corpus and are not used here). `corpora/xd-metadata.zip` (same host,
  `xd-metadata.zip`) was also downloaded to read each candidate's
  publication date and grid size from `xd/puzzles.tsv` before picking which
  files to extract and check.
- Date/publisher scope: only `gxd/nytimes/<year>/*.xd` entries dated before
  1965-01-01 were considered, and only years 1929-1963 - the window in which
  "claimed: not renewed" is the applicable public-domain basis (see below).
  The earliest NYT puzzle in the corpus is from 1942 (the NYT crossword did
  not exist before then), so no candidate here can claim the unambiguous
  pre-1929 basis; a 1964-or-later puzzle was deliberately excluded because
  the Copyright Renewal Act of 1992 made renewal automatic for US works
  first published in 1964 or later, which is a different, weaker basis than
  "claimed not renewed" and outside what this task's basis wording covers.
- Grid size: every candidate that satisfies both the B42 leakage check
  (below) and the date scope above turned out to be 15x15. This was checked
  exhaustively, not assumed: a scan of all 1,175 pre-1965 NYT Sunday-size
  puzzles in the corpus (431 at 21x21, 744 at 23x23) found zero that are
  B42-clean with their real, unedited clue text - a puzzle with 100+ clues
  makes it near-certain that some clue's prose contains some other answer
  in the grid as a substring purely by chance (a 2-3 letter word inside a
  longer common word), and short answers are unavoidable at MIN_RUN=2. No
  clue text was edited to force a pass (that would mean fabricating the
  puzzle, which this task's decisions rule out), so the four fixtures below
  are all 15x15 weekday dailies. This also matches this task's own guidance
  to prefer small grids (15x15 or smaller): the corpus has nothing smaller
  than 15x15 for pre-1965 NYT, so 15x15 is the smallest and, empirically,
  the only B42-clean size available.
- Difficulty spans instead by day of the week (the NYT's difficulty ramps
  Monday, easiest, through Saturday, hardest) and by four different years
  (1950, 1955, 1959, 1962): Monday, Wednesday, Thursday and Friday puzzles
  are represented.
- Each of the four was verified to parse cleanly through
  `loadPuzzleWithSolution` (`src/puzzle/loader.ts` ->
  `src/puzzle/adapters/xd.ts`, T25) and pass the B42 no-solution-leak check;
  see `test/unit/puzzle/fixtures.test.ts` (owned by this task), which
  asserts this for all four files on every test run.
- No rebus cells, no unfilled (`.`) cells: the xd adapter rejects both, so a
  file with either would already have failed to load (see T25's build note
  on `GRID_CHAR_RE` for how a rebus digit would surface).
- No Guardian puzzle is included (A2 keeps that adapter to personal
  research, never a committed fixture).

## nyt-1950-10-12.xd

- **Source URL:** https://xd.saul.pw/xd-puzzles.zip (archive entry: `gxd/nytimes/1950/nyt1950-10-12.xd`)
- **Publication date:** 1950-10-12
- **Grid size:** 15x15 (weekday daily, Thursday)
- **Public-domain basis:** Pre-1965 US publication with no evidence of renewal. Published 1950, in the 1929-1963 window where a US work required an explicit renewal filing in its 28th year (around 1978) to keep copyright. Claimed: not renewed; unverified - no US Copyright Office renewal-record search was performed for this specific puzzle.
- Title in file: "New York Times, Thursday, October 12, 1950"; Author: Unknown; Editor: Margaret Farrar.

## nyt-1955-06-06.xd

- **Source URL:** https://xd.saul.pw/xd-puzzles.zip (archive entry: `gxd/nytimes/1955/nyt1955-06-06.xd`)
- **Publication date:** 1955-06-06
- **Grid size:** 15x15 (weekday daily, Monday)
- **Public-domain basis:** Pre-1965 US publication with no evidence of renewal. Published 1955, in the 1929-1963 window requiring renewal (28th year around 1983). Claimed: not renewed; unverified - no US Copyright Office renewal-record search was performed for this specific puzzle.
- Title in file: "New York Times, Monday, June 6, 1955"; Author: Sidney Lambert; Editor: Margaret Farrar.

## nyt-1959-04-24.xd

- **Source URL:** https://xd.saul.pw/xd-puzzles.zip (archive entry: `gxd/nytimes/1959/nyt1959-04-24.xd`)
- **Publication date:** 1959-04-24
- **Grid size:** 15x15 (weekday daily, Friday)
- **Public-domain basis:** Pre-1965 US publication with no evidence of renewal. Published 1959, in the 1929-1963 window requiring renewal (28th year around 1987). Claimed: not renewed; unverified - no US Copyright Office renewal-record search was performed for this specific puzzle.
- Title in file: "New York Times, Friday, April 24, 1959"; Author: A. H. Drummond, Jr.; Editor: Margaret Farrar.

## nyt-1962-03-21.xd

- **Source URL:** https://xd.saul.pw/xd-puzzles.zip (archive entry: `gxd/nytimes/1962/nyt1962-03-21.xd`)
- **Publication date:** 1962-03-21
- **Grid size:** 15x15 (weekday daily, Wednesday)
- **Public-domain basis:** Pre-1965 US publication with no evidence of renewal. Published 1962, in the 1929-1963 window requiring renewal (28th year around 1990). Claimed: not renewed; unverified - no US Copyright Office renewal-record search was performed for this specific puzzle.
- Title in file: "New York Times, Wednesday, March 21, 1962"; Author: Louise Earnest; Editor: Margaret Farrar.

## Licence basis needs Ben's review before any redistribution claim
