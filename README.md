# ⚽ FPL Optimizer

A complete Fantasy Premier League dashboard that finds **the best possible team for the next gameweek** — starting from the squad you had last week, with every official FPL rule built in.

Enter your FPL ID and get:

- **Optimal team**: best XI, formation and bench order from expected points (xP)
- **Transfer plans** for 1–3 moves, weighed against −4 hits — the app tells you when keeping your team is the better play
- **Captaincy ranking** for the next gameweek
- **Chip advisor**: projected gain from Wildcard, Free Hit, Bench Boost and Triple Captain right now
- **Stats**: sortable player table with xP, form, xGI, price and ownership
- **Fixture ticker** with FDR for the next 5 gameweeks (easiest first)
- **Live points** with auto-refresh, **mini-league standings** and **season history** charts
- A finance-style KPI row: every headline card shows its **change vs ~a month ago** (4 gameweeks), color-coded by direction

Dark theme, mobile-first.

## Getting started locally

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # 39 unit tests (rules engine + optimizer)
```

In sandboxes without access to the FPL API you can run against a built-in mock:

```bash
npm run mock-api                          # mock FPL API on :4100
FPL_API_BASE=http://localhost:4100 npm run dev
```

## Deploy to GitHub + Vercel

1. **GitHub**: create an empty repo (e.g. `fpl-optimizer`) on github.com, then push:

   ```bash
   git remote add origin https://github.com/<username>/fpl-optimizer.git
   git push -u origin main
   ```

   (Or with the GitHub CLI: `gh repo create fpl-optimizer --public --source=. --push`)

2. **Vercel**: go to [vercel.com/new](https://vercel.com/new), sign in with GitHub, pick the repo and hit **Deploy**. Next.js needs zero configuration. Done — the site is live, and every push to `main` deploys automatically.

CI (lint + test + build) runs on GitHub Actions on every push.

## Architecture

```
src/
├── app/
│   ├── page.tsx                  # Landing: FPL ID input + validation
│   ├── team/[id]/page.tsx        # The dashboard
│   └── api/fpl/[...path]/route.ts# Proxy to fantasy.premierleague.com (required: no CORS)
├── lib/
│   ├── rules.ts                  # The FPL rules engine (see below)
│   ├── xp.ts                     # Expected-points model — every weight in XP_CONFIG
│   ├── optimizer.ts              # Best XI + beam search over transfer combinations
│   ├── fpl.ts                    # Data layer: fetches and assembles squad state
│   └── types.ts                  # Types for the FPL API
└── components/                   # Pitch, OptimizePanel, StatsTable, etc.
```

### The rules engine (`lib/rules.ts`)

Implements and unit-tests the official rules: a 15-man squad (2 GK / 5 DEF / 5 MID / 3 FWD), max 3 per club, all 8 valid formations, **selling prices** (purchase price + 50% of any rise, rounded down to the nearest £0.1m — computed from your actual transfer history), free transfers with banking (up to 5) and −4 hits, and chips. Chip availability is read **dynamically** from the API (windows and counts), so the app survives rule changes between seasons.

### The xP model (`lib/xp.ts`)

Per player per gameweek: xG/xA per 90 weighted by fixture difficulty (FDR) and home/away, clean-sheet probability for GK/DEF, expected goals-conceded penalty, bonus points from ICT, and minutes probability from status/injury flags and minutes share. Blended with form (points per game) and FPL's own `ep_next` for the immediate gameweek. Double and blank gameweeks are handled automatically via the fixtures endpoint. Every weight lives in `XP_CONFIG` — tune it and see what happens.

### The optimizer (`lib/optimizer.ts`)

The best XI is found exactly by enumerating all valid formations. Transfer suggestions use **beam search**: every legal 1-move swap is evaluated (position, budget with true selling prices, club limit), and the best states are expanded to 2 and 3 moves. The objective is the sum of best-XI xP (incl. captain) over the chosen horizon, minus hits. Chip gains come from the same model (Bench Boost = bench xP, Triple Captain = captain's xP, Wildcard/Free Hit = optimal squad within your team value vs your current squad).

## Data source

The official, public FPL API (`https://fantasy.premierleague.com/api/…`) via a server-side proxy with caching (5 min for bootstrap/fixtures, 60 s for live). No login, no database — everything is computed from your FPL ID.

---

Unofficial app — not affiliated with the Premier League or FPL.
