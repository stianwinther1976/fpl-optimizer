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
npm test                  # vitest run — the main suite (~457 tests)
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
- `../fpl-live/snapshot` — a snapshot of the live FPL API
  (`bootstrap-static.json`, `fixtures.json`, `element-summaries.json`,
  `meta.json`). Produced by `.github/workflows/fpl-snapshot.yml`, which publishes
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
src/lib/demo.ts             the synthetic demo universe (entry id 999999)
scripts/                    measurement harnesses, not shipped
```

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
## Chip timing: two registers that must not mix

`src/lib/chips.ts` reasons about chips over the rest of the season; the chip
advisor in `optimizer.ts` still scores them in expected points over the
projection horizon. These are deliberately separate and must stay so:

- **Scored** — inside the horizon. Expected points, from `projectAll`.
- **Structural** — beyond it. Fixture *counts* only, from the published
  calendar. Never a points claim, because `perGw` twenty weeks out would be a
  number with no evidence in it.

Two rules the tests pin, both of which produce actively wrong advice if broken:

- **Clip every window to the chip's own.** Since 2025/26 there are two of each
  chip and each expires (`bootstrap.chips`; GW2–19 and GW20–38 in 2026/27).
  Suggesting a GW29 double for a chip that dies at GW19 is worse than silence.
- **"No window published" ≠ "every window has closed."** `chipWindow` returned
  null for both, so an expired chip came back as *unknown* and the advisor said
  nothing instead of saying it had expired.

Note also that `wcGain` is `max(0, bestSquadWithinValue − keepSquad)` — bounded
below by zero, and a fresh squad beats a held one over *any* window. It is the
size of a gap, not a reason to play the chip, and the copy says so.

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
