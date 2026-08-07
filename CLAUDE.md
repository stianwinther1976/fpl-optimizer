# FPL Optimizer

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript strict · Tailwind v4 ·
Vitest. Deployed on Vercel, auto-deploying from `main`, live at
**fploptimize.com** (no "r" — `fploptimizer.com` belongs to someone else).

Reads the official public FPL API through a server-side proxy at
`/api/fpl/[...path]`. No login, no database: everything is computed from an FPL
entry id.

## Commands

```bash
npm run dev          # local dev server
npm run build        # production build — run before claiming anything is done
npm test             # vitest run — the main suite (~457 tests)
npm run lint         # eslint
npx tsc --noEmit     # typecheck
```

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

- The optimizer maximises points, never points **relative to the field**. There
  is no template/effective-ownership reasoning anywhere. This is the biggest
  open modelling gap.
- `pickBestXi` chooses the XI on expected points alone — no autosub term, no
  variance, no captain-downside. An autosub-aware objective *was* built and
  measured for `buildSquadWithinBudget` and was worse on the live model; see the
  note at `src/lib/optimizer.ts:419`. No equivalent has been measured for
  `pickBestXi` itself.
- `fetchPastSeason` accepts an `AbortSignal` and nothing passes one, so changing
  entry id mid-fetch leaves ~400 requests running alongside the new ones.
