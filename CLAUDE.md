# FPL Optimizer

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript strict · Tailwind v4 ·
Vitest. Deployed on Vercel, auto-deploying from `main`, live at
**fploptimize.com** (no "r" — `fploptimizer.com` belongs to someone else).

Reads the official public FPL API through a server-side proxy at
`/api/fpl/[...path]`. No login, no database: everything is computed from an FPL
entry id.

## Commands

```bash
npm run dev               # local dev server
npm run build             # production build — run before claiming anything is done
npm test                  # vitest run — the main suite (~791 tests)
npm run lint              # eslint
npx tsc --noEmit          # typecheck the app
npm run typecheck:scripts # typecheck scripts/ — a separate tsconfig
```

`typecheck:scripts` is easy to forget and is the only check that reaches the
harnesses below: they are outside `vitest.config.ts`'s `include`, so `npm test`
never compiles them. They sat with eight type errors — two of them real bugs —
until someone ran it.

Four extra vitest configs exist for slow measurement harnesses that are NOT part
of the main suite and are run by hand:

```bash
npx vitest run -c vitest.backtest.config.ts    # replays archived seasons
npx vitest run -c vitest.sim.config.ts         # season simulation
npx vitest run -c vitest.preseason.config.ts   # pre-season draft harness
npx vitest run -c vitest.yt.config.ts          # app drafts vs published squads
```

These read data from sibling directories, not from this repo:

- `../fpl-data` — a clone of `github.com/vaastav/Fantasy-Premier-League`, the
  archived seasons (~200 MB). Backtests need it.

  A sandbox whose GitHub access is scoped to this repository cannot fetch it.
  `.github/workflows/measure.yml` is the way round that: a runner clones it
  (sparse — the harnesses read only `teams.csv`, `players_raw.csv`,
  `fixtures.csv` and `gws/`), runs a harness, and prints the numbers to the job
  log. **It publishes nothing.** Mirroring somebody else's compilation into this
  repository is a licensing decision, not a workflow's to make; check the
  archive's LICENSE first if that is ever wanted. Fire it from the Actions tab,
  or by pushing to `run-measurement`.
- `../fpl-live/snapshot` — a snapshot of the live FPL API
  (`bootstrap-static.json`, `fixtures.json`, `element-summaries.json`,
  `event-live.json`, `meta.json`). `event-live.json` is not a model input; it
  is there so the live payload can be read, which is what three shipped defects
  turned on — see "The lesson those two cost" below. Produced by `.github/workflows/fpl-snapshot.yml`, which publishes
  to the `fpl-snapshot-out` branch. Trigger it by pushing to the `data-snapshot`
  branch, or run `scripts/snapshot/fetch-snapshot.mjs` directly if the machine
  can reach `fantasy.premierleague.com`.

## Hard rules

- **No Norwegian anywhere in the app.** The UI, comments and commit messages are
  English. (Chat with the owner is in Norwegian; that is separate.)
- **Only the official FPL API.** Never scrape FPL Review, Fantasy Football Hub,
  footballanalytics.ai or any other paywalled or subscription source.
- **Never `git checkout <tracked file>`.** To back out an experiment, copy the
  file to `/tmp` first and restore from there, verifying with `test -s`.
- Delete throwaway probe/harness files before committing. They also fail
  `no-explicit-any` lint.

## How this codebase argues

The comments in `src/lib/xp.ts` and `src/lib/optimizer.ts` are unusually long on
purpose. They are a record of what was **measured**, including experiments that
failed and were reverted. Two conventions follow from that, and they matter more
than anything else in this file:

1. **Do not write a number in a comment you have not measured.** If a comment
   claims a model change is worth +0.3 points or that 8 of 300 players are
   affected, someone ran it. Reproduce or re-measure before repeating a figure,
   and correct it in place if it has drifted.

2. **Do not tune a constant without a sweep, and say when a value is not
   identified.** Several config values in `XP_CONFIG` carry an explicit note that
   the surface around them is flat and that they are interior points rather than
   fitted optima. Respect that: re-tuning on a small `n` is how noise gets
   shipped.

Corollary: when adding a test for a behaviour change, **mutation-test it** —
revert the change and confirm the new test goes red. A test that cannot fail on
the thing it was written for is worse than no test, and this repo has caught that
mistake more than once.

3. **Re-audit the fix, not just the bug.** A night of parallel audits found
   real defects and shipped fixes for all of them; a second pass pointed at
   those fixes found that **four of them were themselves wrong** — a
   `Cache-Control` directive that did the reverse of what its own comment
   claimed, a guard that never fired for any install that exists, a focus trap
   that fought itself when two sheets were open, and a fallback that
   reintroduced the bug it replaced.

   Every one had passing tests. Three of the four passed because the test
   asserted the same thing the code did — the header STRING rather than its
   semantics, the token rather than the behaviour. That is the mutation-testing
   rule above failing in a way mutation testing cannot catch: the mutation goes
   red and the fix is still wrong, because the test and the code share a
   misunderstanding.

   The only thing that caught them was reading the spec (RFC 9111 for the
   header) and asking "what state is every existing user actually in?" for the
   guard. When a fix turns on how something OUTSIDE this repo behaves — an HTTP
   cache, a browser, FPL's API — the test can only pin what you already believe.
   Go and check the belief.

## Testing setup

`vitest.config.ts` is `include: ["src/**/*.test.ts"]`, `environment: "node"`.

**There is no jsdom and no @testing-library.** React components are therefore not
rendered in tests. Structural invariants about components (hook wiring, effect
dependencies, JSX shape) are guarded by source-level regex and brace-scanning
checks in `src/lib/__tests__/componentInvariants.test.ts`. If a component fix
needs a guard, add it there rather than reaching for a DOM.

Probe/diagnostic scripts must live inside the repo tree (e.g.
`src/lib/__tests__/zz_probe.test.ts`) — a file in `/tmp` cannot resolve the `@`
alias under vite-node. Run them with:

```bash
npx vitest run <path> --reporter=verbose --silent=false
```

Plain `vitest run` swallows `console.log`.

## Layout

```
src/app/                    routes; api/fpl proxy, api/demo synthetic universe
src/components/             Dashboard, Pitch, OptimizePanel, PlayerModal, ...
src/lib/xp.ts               the projection model — the heart of the app
src/lib/optimizer.ts        squad building, best XI, transfer plans, chips
src/lib/pool.ts             candidate shortlisting (launchPool for pre-season)
src/lib/rules.ts            FPL rule constants
src/lib/field.ts            the competition: ownership, template/differential
src/lib/chips.ts            chip windows and timing (see the section above)
src/lib/live.ts             in-play: match clock, provisional bonus, autosubs
src/lib/lineup.ts           the READER's team-news overrides (see below)
src/lib/display.ts          display arithmetic, extracted so it can be tested
src/lib/recent.ts           recently-viewed teams, localStorage only
src/lib/demo.ts             the synthetic demo universe (entry id 999999)
scripts/                    measurement harnesses, not shipped
```

`display.ts` exists because components cannot be rendered in tests here. Any
arithmetic a component would otherwise inline goes there and is tested
properly; `componentInvariants` then pins the call site to the helper, because
extracting the arithmetic and leaving the old expression behind would pass every
test in `display.test.ts` while shipping the original bug.

`lineup.ts` is the one place the app takes an opinion from the READER rather
than from data: a manager who has seen a press conference can mark a player as
starting or benched, and `projectAll` applies it last. Two things about it:

- The override is **asymmetric on purpose**. "Starts" raises a player's share
  but never lowers it; "benched" lets it fall. A reader's team news is evidence
  that someone plays, not evidence about how much.
- **Calibration must never learn from it.** The run `Dashboard` snapshots for
  grading is projected with `startCalls: new Map()` explicitly. Otherwise a
  reader who marks a £4.0m defender "starts" and sees him not play teaches the
  calibration that the MODEL over-rates defenders — a real correction, applied
  globally, sourced from somebody else's mistake.

  That exception is for the READER's opinion and nothing else. Everything the
  model itself consumes — last season's record, recent line-ups — must be in the
  graded run, or the calibration is grading a projection the app does not ship.
  That failure has now happened twice, once per input.
- **It expires with its gameweek.** The stored payload carries the gameweek it
  was made for (`squad.nextEvent`, the same anchor `projectAll` calls offset 0)
  and is dropped once that gameweek is behind. Nothing expired it before, and
  the round that scoped the override to offset 0 made that sharper rather than
  milder: it now lands entirely on ONE gameweek, so if that gameweek is the
  wrong one there is nothing left to dilute it — a median 0.94 and up to 2.85
  off `next` on the 2026-08-21 snapshot.

## FPL data conventions worth knowing

- `history.current[].points` is **gross**, with `event_transfers_cost` beside it.
  `total_points` is cumulative **net**. `average_entry_score` is net.
- `entry_history.value` **includes the bank**, so it is not squad value.
- `entry/{id}/history/` rows carry no `active_chip`; chips are a separate array.
- Pre-season, every `strength_attack_*` / `strength_defence_*` is 0, so the model
  falls back to FPL's published integer FDR. A different code path runs in
  season; numbers measured pre-season do not transfer.
- Transfer hit is 4 points, max 5 free transfers, £100.0m initial budget, 15-man
  squad, max 3 per club.
- A fixture's **`minutes` stops at 90**. It tracks the real clock up to there and
  then freezes, so a match in stoppage reads exactly 90 for as long as it runs.
  The app shows `90+'`; claiming "90'" through four more minutes of football is a
  claim the data cannot support.
- **`finished` means bonus confirmed, not "the match has ended."** The final
  whistle is `finished_provisional`, and after a Saturday afternoon the two are
  hours apart. Use the provisional flag for anything about the MATCH, and
  `finished` for anything about the POINTS — `gwDone` deliberately still waits
  for `finished`, because bonus is still moving while it is provisional.

### The lesson those two cost, which is the general one

Both were live for a whole season for the same reason: **the FPL API sent a
field and `types.ts` did not model it, so nobody knew it was there.** The match
clock was estimated from `now - kickoff` with a flat 15 minutes knocked off for
half time — measured 6 minutes fast at the death — while `minutes` sat in the
payload unread. Then full time was read off the wrong flag while
`finished_provisional` sat beside it, also unread.

**It has now happened a third time.** `provisionalBonus` abstained from every
double gameweek on the stated premise that "FPL publishes BPS only as a gameweek
total". It does not: `fixtures/` carries a per-fixture `stats` array with a `bps`
row for every player who appeared, split home and away, on the very objects that
function was already being handed. Read off the snapshot — GW1 fixture 1, 30 rows
for the 30 players who appeared, −8 to 41, and the top three are exactly the
three the `bonus` rows pay 3, 2 and 1.

Three for three, and the tests never help: in each case the suite asserted the
same belief the code held. Before writing an estimator, an abstention, or a
fallback for anything, **dump the actual payload and look.** The snapshot on the
`fpl-snapshot-out` branch is there precisely so you can, and `fixtures.json` is
worth re-reading in full whenever something in `live.ts` says the API does not
send something.

Two related habits that follow:

- `SquadState.players` is the squad to OPTIMIZE FROM — pending transfers
  applied, and in a Free Hit week the pre-Free-Hit fifteen. It is not what is on
  the pitch. Anything rendering this gameweek's scores wants `currentPlayers`.
- `live.elements[].stats` is a GAMEWEEK TOTAL. For anything about one match, use
  `fixtureLines` in `live.ts`, which reads `explain[].fixture` and the fixture's
  own `stats`.

### Live data must not be cached by the browser

`Cache-Control` on the proxy carries `no-cache` as well as `s-maxage`, and the
CDN gets its own `CDN-Cache-Control` (RFC 9213) because the two layers want
opposite things and one header cannot say both. The browser half was missing and
took four attempts: `s-maxage` binds shared caches only, so with `public` and no
`max-age` a browser is given no freshness lifetime, falls back to heuristic
caching and picks its own — iOS Safari picked minutes. The 30-second live poll
was answered from the phone's own store while `updatedAt` was stamped "now" on
every hit, so the app reported refreshing and had not. `max-age=0` did not
finish the job either, because `stale-while-revalidate` binds private caches
too; `proxy-revalidate` was backwards on both counts (RFC 9111 §5.2.2.9). The
client sends `cache: "no-store"` for `fixtures/` and `event/{id}/live/` as the
second belt.

**The origin does not cache at all any more, deliberately.** The upstream fetch
carries `cache: "no-store"` rather than `next: { revalidate }`, because Next
awaits its own background revalidation before completing the request
(`withExecuteRevalidates` in `next/dist/server/revalidation-utils.js`) while
`patch-fetch` has stripped the caller's abort signal from it. Measured against a
stub that accepts the connection and never answers: a cold miss returned 502 at
10.01s and a STALE entry was still open at 120s. All caching is therefore at the
edge, where `stale-while-revalidate` serves a reader through an origin failure
without holding anyone's response open. The one thing the Data Cache did that is
worth keeping — folding concurrent readers of the same path into one upstream
fetch — is an explicit in-flight map in the route; 20 concurrent identical
requests produce exactly one upstream fetch.

A "Refresh now" control must also bypass the in-memory memo in `fpl.ts`
(`get(path, force)`), or it returns the promise the caller already had — a
button labelled "now" that does nothing, pressed exactly when the numbers look
wrong.

## Demo mode

Entry id `999999` serves a synthetic mid-season universe (GW20 just played) from
`/api/demo/[...path]`, in the same endpoint shapes as the real proxy. It is
deliberately invariant in wall-clock time: in-play fixtures are pinned so they
always render at 58'. `makeDemoUniverse(NOW)` builds it; tests use
`const NOW = Date.UTC(2026, 0, 15, 12, 0, 0)`.

## Known gaps, not yet fixed

- The optimizer maximises points and **builds squads** with no reference to the
  field. `src/lib/field.ts` now models the competition — ownership, the
  template/differential split, and what the API does and does not publish about
  armbands — and the captaincy view reports it, but `buildSquadWithinBudget`,
  `planHorizon` and `pickBestXi` are untouched and still purely points-driven.

  Read `field.ts`'s header before extending it. The argument there matters more
  than the code: maximising expected points *already* maximises expected
  points-against-the-field, exactly, because the field's expected score is a
  constant with respect to your picks. Ownership changes the **variance** of
  your margin, not its mean. So the usual `xp * (1 - EO)` reweighting is not a
  sharper model — it silently swaps the objective. Anything rank-aware added
  here has to be a stated appetite for spread (`differentialTolerance`, in
  points, default 0 = off), never a fitted weight.
- `pickBestXi` chooses the XI on expected points alone — no autosub term, no
  variance, no captain-downside. An autosub-aware objective *was* built and
  measured for `buildSquadWithinBudget` and was worse on the live model; see the
  note at `src/lib/optimizer.ts:419`. No equivalent has been measured for
  `pickBestXi` itself.
- **The in-season minutes model has no shrinkage.** `pStart` is `starts /
  teamGames` at face value, so after one round a player is 1.000 or 0.000 with
  no confidence scaling at any `teamGames` — while the pre-season branch shrinks
  toward a prior with 6 pseudo-games. `buildStrengths` counts finished fixtures
  PER CLUB, so at GW1 the two regimes are live simultaneously: two clubs scored
  on one game against eighteen on the pre-season prior. Fixing it means a sweep
  on `../fpl-data`, which no sandbox scoped to this repository can fetch —
  `.github/workflows/measure.yml` is the route.
- **`buildStrengths.usable` may be permanently false on the live feed.** All
  four `strength_attack_*`/`strength_defence_*` are 0 on every snapshot taken so
  far, including one with a gameweek in progress, and `strength_overall_*` are
  now integers on a 1-5 scale rather than the ~1000-1400 the `spread > 40`
  threshold assumes. So the Poisson opponent branch does not run in production,
  and `demo.ts` builds its clubs on the old scale — meaning the tests exercise a
  branch production may never reach. Take a mid-season snapshot and look before
  concluding either way.
- **The price predictor has never been observed firing on real data.** Counted
  on both live snapshots, all 600 elements: `price_change_percent` is the
  string `"0"`, `price_change_hourly_rate` 0, `price_change_locked_until` null,
  `price_change_calibrating` false, and all three `price_change_projections`
  rows `{projected_percent: "0", likelihood: 0}` — FPL freezes prices until
  after the GW1 deadline. So `priceChange.ts`'s thresholds have only ever been
  exercised on the demo, which generates its own values. The four extra fields
  are now in `types.ts` (the file's header used to say the API published none
  of them, and reasoned from that); `likelihood` is exactly the confidence
  `NOTABLE` and `imminent` approximate. Take a mid-season snapshot with prices
  moving and look before building on any of it.

- **`dcPer90` divides by an arbitrarily small denominator.** Every other rate in
  `playerRates` goes through `shrunk90`; this one does not, so 5 defensive
  contributions in 20 minutes reads as 22.5 per 90. Low impact today because the
  players it reaches have low `pStart`, but it is the same shape as the bug
  `shrunk90` exists to prevent.
## Chip timing: two registers that must not mix

`src/lib/chips.ts` reasons about chips over the rest of the season. **Structure
finds the candidate gameweeks; scoring resolves them.** The calendar is scanned
over the chip's whole window (cheap, and trustworthy months ahead because it is
a schedule, not a forecast); only the gameweeks it *flags* are then projected
and scored.

Do not "simplify" this into projecting the whole window. It was measured, and
the reason is not cost:

- Over GW1–19 on the 2026-08-07 snapshot with no blank or double anywhere,
  bench xP ran 11.37–12.28 — the best week beat the best-inside-five by
  **0.12 points**. A far-out projection does not go wild, it goes **flat**, and
  an argmax over a surface that flat is fitting noise.
- Cost is small but *does* scale with the horizon: `projectAll` medians are
  9.7 ms at horizon 5, 19.5 at 12, 27.9 at 19, 37.6 at 29 (nine interleaved
  runs after warmup). An earlier version of this note claimed 58 ms against
  63 ms and concluded the cost was flat in the horizon — both figures were
  measured cold and were mostly first-call overhead. Cost still is not the
  constraint; the flat surface is.
- Structure, by contrast, moves it hugely: injecting a GW30 double took the
  bench from 11.16 to 15.41 and the XI from 45.62 to 82.50.

Hence `MATERIAL_GAIN` (0.9) — a measured **noise floor**, not a tuned constant.
It is the no-structure spread above; a flagged week must beat the in-horizon
best by more than that before the app recommends waiting for it. Below it the
double is still *named* (it is a fact about the calendar) but not recommended.

Two rules the tests pin, both of which produce actively wrong advice if broken:

- **Clip every window to the chip's own.** Since 2025/26 there are two of each
  chip and each expires (`bootstrap.chips`; GW2–19 and GW20–38 in 2026/27).
  Suggesting a GW29 double for a chip that dies at GW19 is worse than silence.
- **"No window published" ≠ "every window has closed."** `chipWindow` returned
  null for both, so an expired chip came back as *unknown* and the advisor said
  nothing instead of saying it had expired.

`wcGain` is the best of three things minus keeping: the greedily-built squad
within team value, the squad itself, and every squad the transfer beam already
evaluated (a wildcard can make those moves without the hit). It is therefore
bounded below by zero and by the best transfer plan's own score — which it was
NOT before, because the builder maximises the sum of `totalDiscounted` over all
fifteen while `horizonScore` counts only the best XI, so its squad is a local
optimum of the wrong objective. Measured on the demo, unclamped: 0.269 / 3.164
/ 0.663 / 0.690 / 5.440 at horizons 1/2/3/5/8, against a best single transfer
of 0.375 / 1.199 / 1.143 / 1.283 / 2.663 — the chip losing to one free transfer
at three of the five. The floor removes the contradiction; it does not repair
the objective mismatch, which is the "known gap" above. It remains the size of
a gap, not a reason to play the chip, and the copy says so. The floor is in
the DECAYED currency, while the transfer card beside it now prints a plain gain
net of the hit, so the guarantee is over the objective rather than over the two
numbers on screen — 4.598 against +4.626 on the demo at horizon 8.

Pre-season there are no blanks or doubles at all: the opening calendar is 380
fixtures, one per club per gameweek. They appear later as cup runs and
postponements force rescheduling, so the advisor says the calendar has not
spoken rather than reporting "nothing better ahead" as a finding.

## The element-summary layer

`element-summary/{id}/` is the only endpoint fetched once per **player** rather
than once per reader, and its payload is read by two consumers for two different
halves: `fetchPastSeason` wants `history_past`, `fetchRecentForm` wants
`history`. Both used to call it independently, minutes apart, so a player in both
sets was fetched twice for two halves of one document — and `fetchCache` never
evicts, so every raw payload stayed in memory for the life of the page.

`fetchSummaries` in `src/lib/fpl.ts` now sits under both: one fetch per player
per session, reduced on arrival, keyed by feed. Three rules it is worth knowing
before touching it:

- **Failures are not cached.** `pastSeasonStore` refuses to treat a result with
  failures as final so the drafter's "Re-draft to try them again" button means
  what it says; recording a miss here would silently take that back.
- **`resetSummaryCache()` is what makes `resetPastSeasonStore()` complete.** A
  reset that left the layer below populated hands the next test records the
  store never fetched.
- **Cancellation is best-effort.** The store aborts the load it overtakes, but
  workers only check the signal between players, so the `loadSeq` guard against
  a superseded load *writing* is still load-bearing and must stay.
