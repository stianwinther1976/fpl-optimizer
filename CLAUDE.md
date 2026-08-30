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
- **FPL caches its own feeds, and the TTLs differ by an order of magnitude.**
  Measured from a runner during GW1 (probe runs 32577720199 and 32581024633),
  reading FPL's own `age` header:

  | Endpoint | Observed max `age` | Effective TTL |
  |---|---|---|
  | `entry/{id}/` | 61 s | ~60 s |
  | `event/{gw}/live/` | 92 s | ~90 s |
  | `fixtures/` | 301 s, resets 301 s apart | **300 s** |
  | `entry/{id}/event/{gw}/picks/` | 56,549 s | **~15.7 hours** |

  Two consequences that both shipped as defects:

  - `fixtures[].minutes` only steps when that five-minute window turns over, so
    the match clock ran 2-8 minutes behind. On IPS-SUN, kicked off 14:00:00Z,
    at 14:18:11Z with 18 minutes played: `fixtures[].minutes` 10, max player
    minutes 16. `matchMinute` therefore takes the larger of the two — see
    `liveMatchMinutes`.
  - **`picks/` is cached for most of a day, and `entry_history` rides inside
    it.** Picks cannot change after the deadline so that is reasonable of FPL,
    but `entry_history.points` and `.rank` move all gameweek. Three entries at
    15:33Z: `summary_event_points` 27/51/44 against `entry_history.points`
    17/27/20. Anything about a LIVE gameweek must come from `entry/{id}/`;
    `event_transfers_cost` is the exception, being fixed once the deadline
    passes.

- **A score derived from `explain` reproduces `fixtures/` exactly.** Summing
  `goals_scored` per player through `explain[].fixture`, with `own_goals`
  counted against the scorer's OWN side, matched `team_h_score`/`team_a_score`
  on all nine of GW1's played fixtures — 25 goals, including a 0-1, a 2-2 and a
  4-0 — on every one of 15 consecutive samples (probe run 32661146740,
  `scripts/snapshot/score-probe.mjs`).

  **And it is fresher.** Measured on Fulham's equaliser against Chelsea (probe
  run 32766378058), sampling both feeds every 20 s:

  | Wall | `fixtures/` | live-derived | `fixtures/` age |
  |---|---|---|---|
  | 19:26:19 | 0-1 | **1-1** | 224 s |
  | 19:26:39 | 0-1 | **1-1** | 244 s |
  | 19:26:59 | 0-1 | **1-1** | 264 s |
  | 19:27:19 | 0-1 | **1-1** | 284 s |
  | 19:27:39 | 1-1 | 1-1 | 4 s |

  The live feed had the goal at least 80 seconds early — four consecutive
  samples — and `fixtures/` only caught up at the instant its 300-second window
  rolled. So `liveFixtureScore` is what the fixture cards and the match modal
  read, with the published score as the fallback.

  Two things it does NOT do, both deliberate. It does not take a `Math.max`
  with the published score the way `matchMinute` does with the clock: minutes
  only increase, goals do not, and a max would make a VAR-disallowed goal
  permanent. And it returns **null**, not 0-0, until `explain` carries a row
  for that fixture — an empty sum would erase a real scoreline rather than
  defer to it, which is the trap `provisionalBonus` documents.

- **`entry.summary_event_points` is live and exact, but excludes provisional
  bonus.** It equalled the effective XI's `total_points` summed off
  `event/{gw}/live/` with the captain doubled, on every sample of all three
  probed entries. Where the app differs from it during the provisional window,
  the difference is the bonus and nothing else — one entry showed 51 against a
  projected 5 of bonus. So a disagreement with FPL's own figure is not by
  itself evidence of a bug; check the bonus term before concluding anything.

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

**Provisional bonus is read at FULL TIME and not before.** The gate was
`started && !finished`, so bonus was projected from the first minute of a
match — and at minute two the BPS table holds a couple of completed passes, so
whoever tops it is awarded points of pure noise. Reported from a live match:
B.Fernandes captained, one appearance point, a projected 2 on top, doubled for
the armband, and the app showed 6 where FPL showed 2. `finished_provisional` is
the one state where the ladder is FINAL and only confirmation is outstanding,
and it is the only one that has been measured. Seven tests passed throughout,
because they built their fixtures the way the code read them.

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

**The live feeds get a freshness budget shorter than one poll.** `fixtures/`
and `event/{gw}/live/` are `s-maxage=10, stale-while-revalidate=20`, so an edge
may serve at most 30 seconds of staleness against a 30-second UI poll. They used
to take `cacheSeconds * 2` off a 25-second window — a 75-second entitlement,
plus up to 30 more before the next poll — which is the arithmetic behind two
separate reports of the clock and the scores lagging during a match. `fixtures/`
counts as live because `matchMinute` reads `minutes` off it, so it carries the
clock. The 75 is arithmetic on the header, not a measurement: no CDN runs in the
sandbox, so what a given edge does with `stale-while-revalidate` is unverified
here.

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

## The safety score, and what measuring it actually found

`LiveTab`'s "Safety score (your rank band)" samples the Overall league at
`page_standings = ceil(summary_overall_rank / 50)` and takes the median live
score. A reader reported it showing **83** during GW2 while his own score was 45
and FPL's published gameweek average was 29 — a median nearly three times the
average of the whole game, which cannot be right for a sample of one's own
neighbours.

Three runner probes took it apart (33317888160, 33318074241, 33318359548,
2026-08-30, GW2, entry 946779):

| Question | Answer |
|---|---|
| `summary_overall_rank` | 6,078,195 → `page_standings=121564` |
| Does FPL honour a page that deep? | **Yes.** Rank 1 at page 1, 4,885 at page 100, 484,962 at page 10,000, 4,964,563 at page 100,000 |
| Does the page bracket the reader? | **Yes**, ranks 5,989,492 … 6,078,195 |
| That band's median live score | 36 (`event_total` and `summary_event_points` agree) |
| `Σ picks(pos ≤ 11) × multiplier × live total_points` vs `summary_event_points` | **identical on all 20 sampled entries** |
| Counting all fifteen instead of eleven | median 42 → 47, highest 42 → 70 |
| **`bandMedianScore` itself, run against the live API** | **44, against FPL's 42** |

So the sample is right, the picks-to-live join is exact, and the shipped
scoring is right: 44 against a band median of 42, the +2 being provisional
bonus, which is what FPL's figure excludes and nothing else. **The 83 was not
reproduced.** Do not repeat it as a measurement of anything.

What the exercise did find are two defects in the SAMPLING, both now fixed:

- **The latch was set before the request.** Twenty `picks` fetches go out at
  once through one proxy and `.catch(() => null)` drops each failure silently,
  so one bad moment on load left the safety score missing — or computed from a
  handful of managers — for as long as the tab stayed open. `bandDone` now
  latches only inside the success branch; `bandBusy` does the job the old ref
  was really doing, stopping a second fetch while one is in flight.
- **The copy asserted "~20 managers" whichever way the sample went.** A median
  over six read exactly like a median over twenty, and six is noisy enough to
  move the message from "on course to climb" to "38 more needed". The tooltip
  now names the real count and the label says so when it is short.

`scripts/bandscore.test.ts` is the harness that settled it, run by
`.github/workflows/clock-probe.yml`. It **imports** `liveEntryScore` rather than
reimplementing it — a probe that re-derives the code under test proves its own
arithmetic against itself, which is the trap `score-probe.mjs`'s header already
records. Run it with `npx vitest run -c vitest.band.config.ts`; it needs the
network and a gameweek in progress.

One row in that run is worth keeping in mind: entry 3269700 came out at 68
against FPL's 55. The app projects auto-substitutions and the vice-captain
takeover that FPL only applies when the gameweek is settled, so it leading by
a wide margin on a squad with blanked starters is the feature working — but
+13 is the largest gap measured, and nothing has checked whether that
projection was RIGHT.

## The deadline watch

`.github/workflows/deadline-watch.yml` runs every six hours on a runner and
force-pushes a plain-text report to the orphan `deadline-watch-out` branch. A
scheduled routine reads it with git and messages the owner only when there is
something to say.

Three things about it are load-bearing:

- **It runs on a runner because the sandbox cannot reach FPL.** `curl` to
  `fantasy.premierleague.com` from here returns `CONNECT tunnel failed, 403`.
- **The report goes to a BRANCH, not the job log.** The routine's sessions run
  without the GitHub MCP tools — a routine created from a session cannot pass
  connector grants on — so they cannot download a job log. They do have git.
  This was written the log way first and would have failed on its first firing.
- **It reports facts, never a recommendation.** Deadline, FPL's own status
  flags, price moves, the bank. Ranking transfers is `planHorizon`'s job, and a
  watcher that guessed at it would be a second, worse optimizer disagreeing with
  the first on the reader's own screen.

`FPL_ENTRY_ID` selects the team and defaults to the owner's, committed in the
workflow. An entry id is public — it is in every league table — and a request
to "remember this" was once kept in context and lost to a compaction. The
repository is the only place that survives.

Scheduled workflows only run from the DEFAULT branch, so a change here does
nothing until it is on `main`.

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

  **And the optimizer deliberately does not use any of it. This is a decision,
  not an omission.** `planHorizon` prices every move in the horizon at today's
  `now_cost` and today's `sellPrice`; a grep of `optimizer.ts` for
  `priceChange`, `cost_change` and `price_change` returns nothing, and that is
  correct. The owner's reasoning, and it is the right one: nobody knows
  tomorrow's prices. Forecasting them weeks out to decide a GW5 transfer would
  put a guess inside the objective, where it becomes indistinguishable from the
  projection and cannot be argued with on screen.

  So the consequence is accepted rather than fixed: a plan made on Tuesday
  assumes Tuesday's prices for a buy three gameweeks away, and re-planning on
  Wednesday silently gives a different answer if a price moved. `now_cost`
  comes off `bootstrap-static` on every load and `sellPrice` is derived from it,
  so the re-plan is automatic and always current — it just does not explain
  itself.

  `priceTimingHint` is the one price-aware thing that ships, and its own comment
  draws the line: "Timing, not selection". It says whether tonight or tomorrow
  is the cheaper moment to make a move that has ALREADY been chosen. It does not
  choose. Keep that separation if anything is added here.

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
bounded below by zero and by the best transfer plan on screen — which it was
NOT before, because the builder maximises the sum of `totalDiscounted` over all
fifteen while `horizonScore` counts only the best XI, so its squad is a local
optimum of the wrong objective. Measured on the demo, unclamped: 0.269 / 3.164
/ 0.663 / 0.690 / 5.440 at horizons 1/2/3/5/8, against a best single transfer
of 0.375 / 1.199 / 1.143 / 1.283 / 2.663 — the chip losing to one free transfer
at three of the five. The floor removes the contradiction; it does not repair
the objective mismatch, which is the "known gap" above. It remains the size of
a gap, not a reason to play the chip, and the copy says so. Both `wcGain` and
the transfer card are PLAIN points: while the floor was decayed and the card was
not, the wildcard came out below a plan the same panel recommends in 43 of 96
swept configurations (horizons 1-8 x free transfers {1,2,3,5} x bank {0,5,20}),
by up to 4.56 points. It is 0 of 96 now.

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
