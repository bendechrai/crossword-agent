# Crossword sources

Candidate sources of machine-readable crossword puzzles for building and benchmarking the solver. Compiled 2026-09-02/03 by fetching and verifying each URL below (see Verification log).

## File formats

| Format | Spec | Open? | Includes solution? | JS/npm parsers (verified) | Notes |
|---|---|---|---|---|---|
| .puz (Across Lite) | No spec published by the original vendor (Litsoft/Across Lite); the binary layout has been reverse-engineered and documented by the community (e.g. the puzpy project) | De facto standard, not formally open | Yes - solution letters are stored in the file (optionally XOR-scrambled if the puzzle is "locked") | `@xwordly/xword-parser` (npm, v1.1.0, TypeScript, MIT); `xd-crossword-tools` (npm, v14.1.0, via a vendored TypeScript port of puzjs); `@confuzzle/puz-crossword` (npm, v1.2.3, GPL-3.0, read+write, last published 2021); `xpuz` (npm, v1.2.1, GPL-3.0, read+write) | Still the lingua franca most solving apps accept |
| .ipuz | ipuz.org / libipuz.org, current spec v2.0.2 | Yes - open, JSON, licensed CC BY-ND 3.0 | Yes - `solution` array field | `xpuz`; `@xwordly/xword-parser`; `xd-crossword-tools` (has an `ipuzToXD` converter) | Easiest format to parse (plain JSON); covers many puzzle kinds beyond crosswords |
| .jpz (Crossword Compiler) | No single canonical published spec page found; XML export format of the Crossword Compiler app, stable and widely documented informally | Not formally open (no standards body), but freely readable/writable and de facto standard through wide tool support | Yes - each `<cell>` carries a `solution="X"` attribute (confirmed by inspecting a real .jpz fixture) | `@xwordly/xword-parser`; `xd-crossword-tools` (has a `jpzToXD` converter, tested against real .jpz fixtures) | Common for UK/cryptic publishers and Crossword Compiler-based constructors |
| .xd | Saul Pwanson's spec at github.com/century-arcade/xd/blob/master/doc/xd-format.md | Yes - open plain text, tooling is MIT licensed | Yes - the Grid section holds the full plaintext solution (one UTF-8 char per cell) | `xd-crossword-tools` / `xd-crossword-tools-parser` (npm, v14.1.0, maintained by Puzzmo, published Aug 2026) | Designed for bulk, git-diffable corpus analysis rather than for a single solving app |

## Sources

### xd crossword corpus (Saul Pwanson / century-arcade)
- URL: https://xd.saul.pw/ and https://github.com/century-arcade/xd
- Formats: native .xd; the pipeline ingests .puz/.ipuz and converts to .xd
- Variety: American-style dailies and Sundays from 30+ publications, from majors (New York Times, LA Times, New Yorker) to indie constructors (e.g. brendanemmettquigley.com)
- Volume: the live site indexes 94,757 grids spanning 1990-2026 (per the site's own stats), but the *publicly downloadable* bulk data is much smaller (see licence note)
- Cadence: ongoing, actively updated pipeline (data page footer read "Generated on 2026-04-28" at verification time)
- Licence/terms: tooling is MIT licensed, but the crossword content itself remains under each puzzle's original publisher's copyright. `xd-puzzles.zip` is the whole corpus - about 89,000 puzzles across 32 publishers, spanning 1942 to 2025, roughly 175 MB - not a curated public-domain subset, and there is no separate public-domain-only download. This project only ever fetches the pre-1965 slice of New York Times dailies within that zip (about 3,800 of the 89,000 puzzles, old enough to be public domain), obtained from the same download by fetching with `--from`/`--to` date filters (T27/T28), never from a distinct archive; every other publisher and date range in the zip stays under its original copyright and is not fetched or redistributed by this project. `xd-clues.zip` (over 6 million answer/clue usages grouped by publication-year, listed on the data page but too large to verify a full download within the session timeout) is the other freely downloadable file
- Fetch: direct zip download, `https://xd.saul.pw/xd-puzzles.zip` (confirmed HTTP 200), filtered to the pre-1965 NYT slice via this project's own `xw fetch xd --from/--to` date options rather than a separate URL; `xd-metadata.zip` is also directly downloadable

### Crosshare
- URL: https://crosshare.org
- Formats: playable in-browser; puzzles can be downloaded per-puzzle as .puz via the page's "More > Download .puz" option; also accepts .puz upload/import for hosting a puzzle
- Variety: free, user/indie-constructed puzzles, American-style themed and themeless plus minis; some constructors on the platform also publish cryptics (e.g. George Ho's "loplop" profile on Crosshare)
- Volume: not established from public pages during this research - unverified
- Cadence: continuous community submissions
- Licence/terms: constructing and sharing is free; individual constructors retain rights to their own puzzles; no bulk-redistribution licence was found
- Fetch: manual, per-puzzle .puz download link on each puzzle's page; no documented public API for programmatic/bulk access was found

### Brendan Emmett Quigley (BEQ)
- URL: https://brendanemmettquigley.com
- Formats: .puz and PDF, one direct file per post (e.g. `/files/1915MoveIng.puz`, confirmed present on the page)
- Variety: indie themeless and themed American-style crosswords, moderate-to-hard difficulty
- Volume: archive numbered past #1915 as of Aug 2026; crosswordfiend.com separately lists 1,659+ of his puzzles via its own archive
- Cadence: roughly twice a week (#1901 on 2026-07-02 and #1915 on 2026-08-20 is 14 puzzles in 49 days)
- Licence/terms: puzzles are free to access; the site displays a copyright notice ("(c) 2026 Brendan Emmett Quigley") but no explicit redistribution terms
- Fetch: direct file URL per blog post, pattern `/files/<slug>.puz`

### Club72 (Tim Croce)
- URL: https://club72.wordpress.com
- Formats: PDF and PUZ, linked via Dropbox from each post
- Variety: freestyle themeless (Tuesdays), themed/variety (Fridays)
- Volume: ongoing archive, roughly two puzzles per week
- Cadence: Tuesdays and Fridays at 6pm Eastern
- Licence/terms: free with an optional "leave a tip" donation link; no formal licence statement found
- Fetch: manual, per-post Dropbox link; no bulk API

### WSJ and Universal (via herbach.dnsalias.com aggregator)
- Official pages: WSJ crossword is playable free at wsj.com/games/crosswords (edited by Mike Shenk); Universal Crossword is syndicated by Andrews McMeel and playable free via aggregators like GoComics/iWin. Neither official site offers a documented direct .puz download
- Unofficial mirror confirmed working: herbach.dnsalias.com hosts raw daily .puz files with a predictable, date-based URL pattern. Verified: `http://herbach.dnsalias.com/uc/uc260901.puz` (Universal, HTTP 200, downloaded and confirmed a valid 15x15 PUZ file with 78 clues and a plaintext solution) and `http://herbach.dnsalias.com/WSJ/wsj260901.puz` (WSJ, HTTP 200)
- Variety: American-style daily/Sunday syndicated crosswords
- Licence/terms: this is a long-standing, personal, unofficial aggregation of copyrighted syndicated content, tolerated in the crossword community for personal solving use but with no formal licence; treat as personal-use only
- Fetch: direct URL, pattern `http://herbach.dnsalias.com/uc/uc<YYMMDD>.puz` (Universal) and `http://herbach.dnsalias.com/WSJ/wsj<YYMMDD>.puz` (WSJ); the server is plain HTTP and redirects to HTTPS

### Newsday (Stan Newman)
- URL: https://www.creators.com/features/newsday-crossword-stan-newman (confirmed reachable)
- Formats: web-playable; crosswordfiend.com's download hub lists Newsday among the syndicated dailies but marks it with an asterisk, meaning "please do not download the file if you are not authorized to do so" (subscription required)
- Variety: daily American-style crossword plus a separate Newsday Sunday
- Cadence: daily
- Licence/terms: syndicated, subscription-gated for the downloadable file
- Fetch: no free direct .puz found; the `xword-dl` scraping tool (below) lists Newsday as a supported source

### Universal / USA Today (official sites) and the xword-dl tool
- USA Today: puzzles.usatoday.com / the USA TODAY Play app offer a limited number of free puzzles per week, with a subscription unlocking the full daily archive; no official bulk .puz download was found
- Universal: playable free via GoComics/iWin; no official .puz download was found
- General-purpose fetch tool: `xword-dl` (https://github.com/thisisparker/xword-dl, README fetched and confirmed) is a command-line scraper that produces .puz files for 40+ outlets, including New York Times (subscriber auth required), New York Times Mini/Midi/Variety, LA Times (+ Mini), The New Yorker (+ Mini), Newsday, Universal, USA Today, Washington Post, several Guardian series (Cryptic, Everyman, Prize, Quick, Quiptic, Speedy, Weekend), Puzzmo, and others
- Licence/terms: the tool itself is open source but makes no claims about the legality of downloading copyrighted daily puzzles; note ".puz conversion may be lossy" (Latin-1 only) per its own README
- Fetch: `xword-dl <keyword> --latest` per source, e.g. `xword-dl usa`, `xword-dl uni`, `xword-dl tny`

### The New Yorker
- URL: https://www.newyorker.com/puzzles-and-games-dept/crossword (confirmed reachable, HTTP 200)
- Formats: web-playable; no official .puz download; reachable via `xword-dl tny`
- Variety: daily crossword plus a mini
- Licence/terms: Conde Nast copyrighted content, largely subscriber-gated

### Guardian crosswords (unofficial JSON)
- URL pattern verified: appending `.json` to any Guardian crossword page URL returns the full page payload as JSON, e.g. `https://www.theguardian.com/crosswords/cryptic/30085.json` (confirmed HTTP 200; parsed as valid JSON)
- Format: the `crossword` object includes `number`, `name`, `creator`, `date`, `dimensions`, `crosswordType`, a link to the official PDF, and an `entries` array where each clue has `clue`, `direction`, `length`, `position`, and a `solution` string with the answer letters - i.e. the full grid and solution are present, not just clues
- Variety: every Guardian crossword series is covered this way, including Quick, Cryptic, Prize, Quiptic, Speedy, Everyman, and Weekend - a good spread of British cryptic difficulty and style
- Volume: decades of archive; cryptic numbering was past 30,000 as of the September 2026 issue checked
- Cadence: daily for Quick/Cryptic, weekly for Prize/Weekend/Everyman/Quiptic
- Licence/terms: this is not a documented or published API - it is the same JSON the Guardian's own front-end fetches to render the page, exposed by the general `.json` suffix trick that works on most Guardian content URLs. It requires no API key, but it is unofficial, undocumented, and could change or be blocked at any time. Guardian's own copyright applies to the puzzle content; this is separate from the official, API-keyed Guardian Open Platform API (open-platform.theguardian.com), which covers articles, not crossword data
- Fetch: direct HTTP GET on `https://www.theguardian.com/crosswords/<series>/<id>.json`, no authentication

### Berkeley Crossword Solver dataset (CrosswordQA, Hugging Face)
- URL: https://huggingface.co/datasets/albertxu/CrosswordQA (confirmed reachable)
- Format: clue/answer pairs only, no grids - 6,782,248 rows with columns `id`, `clue`, `answer`, distributed as CSV and Parquet
- Sources: scraped from the New York Times and roughly 26 other crossword publishers, built to train the Berkeley Crossword Solver's QA model (ACL 2022 paper, github.com/albertkx/Berkeley-Crossword-Solver)
- Licence: listed as "unknown" on the Hugging Face page - treat with caution for anything beyond research use
- Fetch: Hugging Face `datasets` library (`load_dataset("albertxu/CrosswordQA")`) or direct file download from the repo

### George Ho's cryptic crossword clue dataset
- URL: https://cryptics.georgeho.org (confirmed reachable; also github.com/eigenfoo/cryptics)
- Format: tabular, Datasette-backed, with clue text, answer, clue number, the blogger's explanation/commentary, puzzle title, and publication date - clue-level data, no grids
- Volume: a little over half a million clues as of a September 2021 snapshot documented on the site; likely larger now but a current count was not confirmed live
- Sources: scraped from several cryptic-crossword blogs and public digital archives
- Licence: no explicit licence statement was found on the fetched page - the underlying clues originate from copyrighted puzzles and bloggers' commentary, so treat as research-use unless the author states otherwise
- Fetch: the Datasette interface supports `.json`/`.csv` export per table/query; the `cryptics` Python package (github.com/eigenfoo/cryptics) can also be used to re-scrape the source blogs

### Kaggle: NYT Crossword Clues & Answers 1993-2021
- URL: https://www.kaggle.com/datasets/darinhawley/new-york-times-crossword-clues-answers-19932021
- Format: clue/answer pairs only, no grids; columns are Date, Clue, and Word/answer, covering 11/21/1993 through 10/31/2021
- Licence: confirmed CC0: Public Domain via the Kaggle dataset API
- Size: 28.6MB, 2 versions, last updated 2021-11-04 (confirmed via the Kaggle API metadata endpoint)
- Fetch: Kaggle API (`kaggle datasets download -d darinhawley/new-york-times-crossword-clues-answers-19932021`) or the web UI

### crosswordfiend.com (daily download aggregator)
- URL: https://crosswordfiend.com/download/ (confirmed reachable)
- Not a raw source itself, but a hand-curated daily hub of links to AcrossLite (.puz) or PDF downloads for NYT, WSJ (Mike Shenk), LA Times, Newsday (Stan Newman, subscription-gated), Universal Daily/Sunday, USA Today, Brendan Emmett Quigley, Jonesin' (Matt Jones), and others, organized by day of the week
- Terms note (from the page itself): "Puzzles that require a valid subscription are marked with an asterisk, please do not download the file if you are not authorized to do so" - a useful, explicit statement of the personal-use expectation that applies across most of these sources
- Fetch: manual, browse the day's links (page is largely static HTML but the actual per-day puzzle links are populated dynamically, so scripted scraping would need a real browser or the site's own feeds)

## Recommendation: top 3 by variety

1. **The xd crossword corpus (Saul Pwanson)** is the broadest source by raw variety: the downloadable `xd-puzzles.zip` alone spans 32 publishers, 1942-2025, about 89,000 puzzles, all normalized into one consistent, git-diffable text format with the solution grid included (the live site's own index is larger still: 94,757 grids, 1990-2026). The major caveat is licensing: the puzzles remain under their original publishers' copyright, so this project only fetches the pre-1965 slice of New York Times dailies within the zip (about 3,800 puzzles, old enough to be public domain) using `--from`/`--to` date filters, alongside the freely downloadable aggregated clue-usage data (`xd-clues.zip`).

2. **The Guardian's unofficial crossword JSON** is the best source of British cryptic variety: Quick, Cryptic, Prize, Quiptic, Speedy, Everyman, and Weekend series are all reachable through the same `.json`-suffix trick, with full grids, clue positions, and solutions included, decades deep, and requiring no authentication. The caveat is that this is an undocumented, unofficial endpoint (not a published API) that could change or be blocked without notice, and the puzzle content remains under Guardian copyright.

3. **xword-dl**, used as a meta-source, spans both American mainstream dailies (NYT, LA Times, Universal, USA Today, Washington Post, Newsday) and part of the cryptic world (several Guardian series, Puzzmo) through one command-line tool, which is convenient for pulling a wide sample of publishers and styles in one workflow. The caveat is that it is a scraper, not a licensed feed: NYT puzzles require a paying subscriber's own credentials, and downloading other publishers' daily puzzles beyond personal use sits in a legal gray area.

For the actual solver project, a practical split is: use the **xd corpus's public data** (the pre-1965 NYT .xd puzzles plus the large clue-usage dataset) and the **Kaggle/CrosswordQA clue datasets** for bulk, license-clean benchmarking at scale, since they are explicitly public domain or research-oriented and need no per-puzzle scraping. For spot-testing specifically on British-style cryptics, pull individual puzzles on demand from the **Guardian JSON endpoint** (any `/crosswords/<series>/<id>.json` URL), supplementing with **George Ho's cryptics dataset** to validate clue-parsing and wordplay-explanation logic against real annotated clues. Free indie .puz feeds (BEQ, Club72) and the herbach.dnsalias.com mirror are good for small, hand-picked American-style test cases, but all of these copyrighted feeds should be treated as personal/research use only, not redistributed in bulk.

## Verification log

- https://libipuz.org/ipuz-spec.html - fetched 2026-09-02/03, confirmed ipuz v2.0.2 spec, JSON-based, CC BY-ND 3.0 licensed, has a `solution` field
- https://registry.npmjs.org/@xwordly/xword-parser/latest and .../@xwordly/xword-parser - fetched, confirmed v1.1.0, describes support for PUZ/iPUZ/JPZ/XD, repo github.com/mjkoo/xword-parser, published 2026-03-28
- https://registry.npmjs.org/xpuz/latest and .../xpuz - fetched, confirmed v1.2.1, GPL-3.0, repo github.com/turnerhayes/xpuz
- https://registry.npmjs.org/@confuzzle/puz-crossword/latest and .../@confuzzle/puz-crossword - fetched, confirmed v1.2.3, last published 2021-06-13, repo github.com/rjkat/confuzzle
- https://registry.npmjs.org/xd-crossword-tools/latest and .../xd-crossword-tools - fetched, confirmed v14.1.0, repo github.com/puzzmo-com/xd-crossword-tools, published 2026-08-05
- https://registry.npmjs.org/puzjs/latest - fetched, confirmed v1.0.2, published 2018-08-19, repo github.com/downforacross/puzjs
- https://raw.githubusercontent.com/puzzmo-com/xd-crossword-tools/main/README.md - fetched, confirms .puz/.ipuz/.jpz-to-.xd conversion and xd-to-JSON tooling
- https://api.github.com/repos/puzzmo-com/xd-crossword-tools/contents/packages/xd-crossword-tools/tests - fetched, confirmed test fixture directories for puz, ipuz, jpz, uclick, amuse, puzzleme formats
- https://raw.githubusercontent.com/puzzmo-com/xd-crossword-tools/main/packages/xd-crossword-tools/tests/jpz/inline-style-sample.jpz - fetched, confirmed real .jpz XML with `<cell ... solution="H" />` attributes
- https://github.com/century-arcade/xd (via WebFetch) and https://raw.githubusercontent.com/century-arcade/xd/master/README.md - fetched, confirmed MIT-licensed tooling, xd-format doc, private `gxd` repo for the full corpus
- https://xd.saul.pw/ - fetched, confirmed 94,757 grids, 1990-2026, 30+ publications
- https://xd.saul.pw/data - fetched, confirmed public download links (xd-metadata.zip, xd-puzzles.zip described on the page as "over 6000 pre-1965 New York Times crossword puzzles", xd-clues.zip described as "over 6 million answer/clue usages"). T60 note: the page's own blurb undersells `xd-puzzles.zip` - direct inspection of the downloaded archive (T27/T48) found the whole corpus in it (about 89,000 puzzles, 32 publishers, 1942-2025), not only the pre-1965 NYT slice the page text calls out; see the corrected "Licence/terms" bullet above
- https://xd.saul.pw/xd-metadata.zip - HTTP 200 confirmed
- https://xd.saul.pw/xd-puzzles.zip - HTTP 200 confirmed
- https://xd.saul.pw/xd-clues.zip - request timed out after 2 minutes (large file); listed on the data page but the direct download itself is unverified
- https://crosshare.org/upload - fetched, page loaded but content was mostly CSS/JS boilerplate; "download .puz" and "no public API" claims are from search-result summaries only and are best-effort, not directly confirmed on the page text - treat volume/API claims as unverified
- https://brendanemmettquigley.com/2026/08/20/crossword-1915-move-ing/ - fetched, confirmed a direct `/files/1915MoveIng.puz` download link and a 2026 copyright notice
- https://club72.wordpress.com/ - fetched, confirmed PDF/PUZ Dropbox links and the Tuesday/Friday 6pm ET cadence
- https://crosswordfiend.com/download/ - fetched via curl, confirmed the page text ("Click a link below to download today's puzzles in either AcrossLite (puz) or Adobe (pdf) format... Puzzles that require a valid subscription are marked with an asterisk, please do not download the file if you are not authorized to do so") and links to NYT, WSJ, LA Times, Newsday, Universal, USA Today, BEQ, Jonesin', and others
- http://herbach.dnsalias.com/uc/uc260901.puz - fetched, HTTP 200, downloaded and confirmed a valid 15x15 PUZ file with 78 clues and a plaintext solution
- http://herbach.dnsalias.com/WSJ/wsj260901.puz - fetched, HTTP 200
- https://www.creators.com/read/newsday-crossword-stan-newman - fetched, HTTP 200 (page reachable, confirming the Newsday/creators.com syndication)
- https://github.com/thisisparker/xword-dl (README) - fetched, confirmed 40+ supported sources including New Yorker, Universal, USA Today, Newsday, several Guardian series, and that NYT requires subscriber auth
- https://www.newyorker.com/puzzles-and-games-dept/crossword - HTTP 200 confirmed reachable
- https://www.wsj.com/news/puzzle - HTTP 401 (requires auth/session; could not verify content directly, consistent with it being subscriber-gated)
- https://www.theguardian.com/crosswords/series/cryptic - fetched, used to find a valid current puzzle ID
- https://www.theguardian.com/crosswords/cryptic/30085.json - fetched directly, HTTP 200, parsed as JSON, confirmed `crossword` object with `entries[]` containing `clue`, `direction`, `length`, `position`, and `solution` fields, plus a link to the official PDF at crosswords-static.guim.co.uk
- https://huggingface.co/datasets/albertxu/CrosswordQA - fetched, confirmed 6,782,248 rows, columns id/clue/answer, license listed as "unknown"
- https://www.georgeho.org/cryptic-clues/ - fetched, confirmed dataset description, "a little over half a million clues" as of September 2021; no licence statement found on the page (unverified)
- https://www.kaggle.com/api/v1/datasets/view/darinhawley/new-york-times-crossword-clues-answers-19932021 - fetched via the Kaggle API, confirmed licenseName "CC0: Public Domain", totalBytes 28,650,316, lastUpdated 2021-11-04
- https://www.crossword-compiler.com/en/help/html/exportingpuzzles.htm - fetched, confirms Crossword Compiler's export-formats help page exists, but did not itself contain a canonical .jpz spec (spec claim instead relies on inspecting a real .jpz fixture from xd-crossword-tools, see above)
- https://www.npmjs.com/package/@xwordly/xword-parser, /xpuz, /@confuzzle/puz-crossword, /xd-crossword-tools - all returned HTTP 403 to the fetch tool (npmjs.com blocks the fetcher's user agent); package details were instead confirmed via the registry.npmjs.org JSON API (see above), which is the authoritative source for the same data
