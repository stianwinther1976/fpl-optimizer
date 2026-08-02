// Client-side data layer: fetch via our proxy and assemble app state.

import type {
  Bootstrap,
  Entry,
  EntryEventPicks,
  EntryHistory,
  EventLive,
  Fixture,
  LeagueStandings,
  OwnedPlayer,
  PastSeasonStats,
  RecentForm,
  SquadState,
  Transfer,
} from "./types";
import { computeFreeTransfers, purchasePriceFor, sellingPrice } from "./rules";
import { DEMO_ENTRY_ID } from "./demo";

export { DEMO_ENTRY_ID };

// Demo mode routes all API calls to the built-in synthetic mid-season data.
let demoMode = false;
export function setDemoMode(on: boolean) {
  demoMode = on;
}

/**
 * WHICH UNIVERSE THE APP IS CURRENTLY READING FROM.
 *
 * Anything that caches player data keyed by element id has to know this,
 * because the two universes number their players the same way: the demo's
 * elements are ids 1..300 and so are three hundred real Premier League
 * footballers. `fetchCache` above is safe by accident — it keys on the URL,
 * which carries `/api/demo` or `/api/fpl` in it — but a cache keyed on ids
 * alone has no way to tell a demo midfielder from the real one wearing his
 * number, and will happily serve one man's season as the other's.
 */
export function currentFeed(): "demo" | "real" {
  return demoMode ? "demo" : "real";
}

export class FplApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

// --- Client-side cache with in-flight deduplication -------------------------
// Mirrors the proxy's cache TTLs so concurrent components (Dashboard, LiveTab,
// MiniLeague) and remounted tabs share one request instead of refetching.
const cacheTtl = (path: string): number => {
  if (path.startsWith("event/") || path.startsWith("fixtures")) return 25_000;
  if (path.startsWith("bootstrap") || path.includes("/history")) return 300_000;
  return 120_000;
};
const fetchCache = new Map<string, { promise: Promise<unknown>; at: number }>();

async function get<T>(path: string): Promise<T> {
  const url = `${demoMode ? "/api/demo" : "/api/fpl"}/${path}`;
  const cached = fetchCache.get(url);
  if (cached && Date.now() - cached.at < cacheTtl(path)) {
    return cached.promise as Promise<T>;
  }
  const promise = (async () => {
    const res = await fetch(url);
    if (!res.ok) {
      throw new FplApiError(
        res.status === 404
          ? "No data found — check that the FPL ID is correct."
          : res.status === 503
            ? "FPL is updating the game right now. Try again in a few minutes."
            : `FPL API error (${res.status})`,
        res.status
      );
    }
    return res.json();
  })();
  fetchCache.set(url, { promise, at: Date.now() });
  // Failed requests must not be cached, or a retry could never succeed.
  promise.catch(() => {
    if (fetchCache.get(url)?.promise === promise) fetchCache.delete(url);
  });
  return promise as Promise<T>;
}

export interface ElementSummary {
  history: {
    element: number;
    round: number;
    minutes: number;
    starts?: number;
    total_points: number;
    opponent_team: number;
    was_home: boolean;
  }[];
  history_past?: {
    season_name: string;
    total_points: number;
    minutes: number;
    starts?: number;
    defensive_contribution?: number;
    goals_scored?: number;
    assists?: number;
    bonus?: number;
    saves?: number;
    ict_index?: string | number;
    expected_goals?: string | number;
    expected_assists?: string | number;
  }[];
}

export type PastSeason = PastSeasonStats;

export const api = {
  bootstrap: () => get<Bootstrap>("bootstrap-static/"),
  fixtures: () => get<Fixture[]>("fixtures/"),
  entry: (id: number) => get<Entry>(`entry/${id}/`),
  picks: (id: number, gw: number) => get<EntryEventPicks>(`entry/${id}/event/${gw}/picks/`),
  history: (id: number) => get<EntryHistory>(`entry/${id}/history/`),
  transfers: (id: number) => get<Transfer[]>(`entry/${id}/transfers/`),
  live: (gw: number) => get<EventLive>(`event/${gw}/live/`),
  league: (id: number, page = 1) =>
    get<LeagueStandings>(`leagues-classic/${id}/standings/?page_standings=${page}`),
  elementSummary: (id: number) => get<ElementSummary>(`element-summary/${id}/`),
};

/**
 * Recent line-up data for a set of players (element-summary endpoint), fetched
 * with limited concurrency; failures are simply left out of the map.
 *
 * A player is included only when the `starts` column is actually present — FPL
 * only began emitting it in 2022/23, and treating an absent column as "started
 * nothing" would bench every player in the squad.
 *
 * `minsPerStart` is measured over the rounds he started rather than derived
 * from the other two, which is the whole reason the rows are read here instead
 * of being reduced to marginals: the joint distribution of (started, minutes)
 * only exists in these rows.
 */
export async function fetchRecentForm(
  ids: number[],
  lastN = 5,
  concurrency = 8,
  onProgress?: (done: number, total: number) => void
): Promise<Map<number, RecentForm>> {
  const out = new Map<number, RecentForm>();
  const queue = [...new Set(ids)];
  let done = 0;
  const worker = async () => {
    for (;;) {
      const id = queue.shift();
      if (id == null) return;
      try {
        const s = await api.elementSummary(id);
        const rows = s.history.slice(-lastN);
        if (rows.length > 0 && rows.some((r) => r.starts != null)) {
          const started = rows.filter((r) => (r.starts ?? 0) > 0);
          const startMins = started.reduce((a, r) => a + (r.minutes ?? 0), 0);
          out.set(id, {
            startShare: started.length / rows.length,
            minsPerGame: rows.reduce((a, r) => a + (r.minutes ?? 0), 0) / rows.length,
            minsPerStart: started.length > 0 ? startMins / started.length : null,
          });
        }
      } catch {
        // no data — season model carries on alone
      }
      done++;
      onProgress?.(done, queue.length + done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return out;
}

/**
 * Parse a numeric field that MAY NOT EXIST, preserving the difference.
 *
 * `history_past` rows only carry `expected_goals` from 2022/23 onward. Coercing
 * an absent field to 0 would tell the model "this striker recorded zero xG in
 * 3000 minutes" — a strong, false piece of evidence that regresses a proven
 * player to nothing. `undefined` means "not measured", and the shrinkage in
 * xp.ts falls back to the positional prior instead.
 */
const num = (v: string | number | undefined | null): number | undefined => {
  if (v == null) return undefined;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? (n as number) : undefined;
};

/**
 * Last season's full stat line per player, from element-summary's history_past.
 * The strongest pre-season signal there is: who actually STARTED, and what they
 * produced per 90 while they were on the pitch. Crucially this survives FPL's
 * summer reset of the bootstrap, so it is what the model runs on once the new
 * season's counters are zeroed.
 *
 * One request per player, so a couple of hundred of them at a time. FPL will
 * occasionally refuse one; a dropped player silently falls back to his price
 * prior, which is exactly the guess this whole function exists to avoid, so
 * each failure is retried once and whatever is still missing is COUNTED and
 * returned. A caller that quietly reports "250/250" while a rate limit ate 190
 * of them is worse than one that admits the gap.
 */
export interface PastSeasonFetch {
  data: Map<number, PastSeason>;
  requested: number;
  /** Players whose summary could not be fetched even after a retry. */
  failed: number;
}

export async function fetchPastSeason(
  ids: number[],
  concurrency = 8,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<PastSeasonFetch> {
  const out = new Map<number, PastSeason>();
  const queue = [...new Set(ids)];
  const requested = queue.length;
  let done = 0;
  let failed = 0;
  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const id = queue.shift();
      if (id == null) return;
      try {
        let s: ElementSummary;
        try {
          s = await api.elementSummary(id);
        } catch {
          // Almost always a transient 429/503 under this much concurrency.
          await new Promise((r) => setTimeout(r, 400));
          s = await api.elementSummary(id);
        }
        const rows = s.history_past ?? [];
        // An entry is written for EVERY player queried, even one with no
        // history at all — "we looked and there is nothing" is itself the
        // signal that separates a new signing from a benched squad player.
        const newest = rows.length > 0 ? rows[rows.length - 1] : null;
        // Per-90 rates come from the most recent season with actual pitch time:
        // a year lost to injury shouldn't erase what the player can do.
        const src = [...rows].reverse().find((p) => p.minutes > 0);
        out.set(id, {
          plSeasons: rows.length,
          seasons: rows.map((r) => ({
            seasonName: r.season_name,
            minutes: r.minutes,
            starts: r.starts,
          })),
          lastSeason: newest
            ? {
                seasonName: newest.season_name,
                minutes: newest.minutes,
                // Passed through verbatim, INCLUDING zero, because zero here
                // is ambiguous and only the consumer can disambiguate it.
                //
                // An earlier version of this comment said `starts` "only
                // exists from 2021/22" and that an absent value is not zero.
                // Both halves are wrong. Counted over the element summaries in
                // the 2026/27 snapshot, not one row before 2022/23 reports a
                // start, and the API never sends `null` for the field — it
                // sends `0`. So there is no absent value to protect here; the
                // real hazard is a `0` on a pre-2022/23 row, which means "not
                // recorded" rather than "did not start". That call needs the
                // season name, so it is made in `startsUnrecorded` in `xp.ts`
                // against `XP_CONFIG.startsRecordedFrom`, which carries the
                // per-season counts that place the cut-off.
                starts: newest.starts,
              }
            : undefined,
          seasonName: src?.season_name,
          points: src?.total_points ?? 0,
          minutes: src?.minutes ?? 0,
          starts: src?.starts,
          defensiveContribution: src?.defensive_contribution,
          goals: src?.goals_scored,
          assists: src?.assists,
          xg: num(src?.expected_goals),
          xa: num(src?.expected_assists),
          bonus: src?.bonus,
          ict: num(src?.ict_index),
          saves: src?.saves,
        });
      } catch {
        // Still no data. The model carries on with prices + ep_next for this
        // player, but the caller is told how many were lost.
        failed++;
      }
      done++;
      onProgress?.(done, requested);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return { data: out, requested, failed };
}

export interface TeamData {
  bootstrap: Bootstrap;
  fixtures: Fixture[];
  entry: Entry;
  /** Picks for the current GW — what the Team/Live views should show. */
  picks: EntryEventPicks | null;
  history: EntryHistory;
  transfers: Transfer[];
  /**
   * Squad to optimize from. Normally derived from current picks + any pending
   * transfers already made for the upcoming GW; in a Free Hit week it is the
   * pre-FH squad that returns at the next deadline.
   */
  squad: SquadState | null;
}

/** Load everything needed for the dashboard for one FPL ID. */
export async function loadTeamData(id: number): Promise<TeamData> {
  setDemoMode(id === DEMO_ENTRY_ID);
  const [bootstrap, fixtures, entry, history, transfers] = await Promise.all([
    api.bootstrap(),
    api.fixtures(),
    api.entry(id),
    api.history(id),
    api.transfers(id),
  ]);

  const currentEvent =
    entry.current_event ??
    bootstrap.events.filter((e) => e.finished).map((e) => e.id).pop() ??
    null;

  let picks: EntryEventPicks | null = null;
  if (currentEvent != null) {
    try {
      picks = await api.picks(id, currentEvent);
    } catch {
      picks = null; // e.g. entry joined late
    }
  }

  // Free Hit week: the current picks are a one-week team. The squad that
  // matters for next GW's transfers is the one from the GW before.
  let basePicks = picks;
  if (picks?.active_chip === "freehit" && currentEvent != null && currentEvent > 1) {
    try {
      basePicks = await api.picks(id, currentEvent - 1);
    } catch {
      basePicks = picks; // fall back rather than fail the whole load
    }
  }

  const squad = basePicks
    ? buildSquadState(bootstrap, entry, basePicks, history, transfers, {
        displayEvent: picks?.entry_history.event ?? basePicks.entry_history.event,
        activeChip: picks?.active_chip ?? null,
      })
    : null;
  return { bootstrap, fixtures, entry, picks, history, transfers, squad };
}

export function buildSquadState(
  bootstrap: Bootstrap,
  entry: Entry,
  picks: EntryEventPicks,
  history: EntryHistory,
  transfers: Transfer[],
  opts?: { displayEvent?: number; activeChip?: string | null }
): SquadState {
  const elementById = new Map(bootstrap.elements.map((e) => [e.id, e]));
  const chipEvents = new Map(history.chips.map((c) => [c.event, c.name]));

  const nextEvent =
    bootstrap.events.find((e) => e.is_next)?.id ??
    (picks.entry_history.event < bootstrap.events.length ? picks.entry_history.event + 1 : null);

  // Transfers already made for the upcoming GW: apply them to the squad and
  // bank so the optimizer works from the team that will actually exist.
  const pending = nextEvent != null ? transfers.filter((t) => t.event === nextEvent) : [];
  pending.sort((a, b) => (a.time < b.time ? -1 : 1));

  const squadIds = picks.picks.map((p) => ({ ...p }));
  let bank = picks.entry_history.bank;
  for (const t of pending) {
    const slot = squadIds.find((p) => p.element === t.element_out);
    if (!slot) continue; // already replaced or data mismatch
    const wasCaptain = slot.is_captain;
    const wasVice = slot.is_vice_captain;
    slot.element = t.element_in;
    slot.is_captain = false;
    slot.is_vice_captain = false;
    bank += t.element_out_cost - t.element_in_cost;
    if (wasCaptain || wasVice) {
      // Reassign the armband to the first remaining original pick that has one.
      const holder = squadIds.find((p) => (wasCaptain ? p.is_vice_captain : p.is_captain));
      if (holder && wasCaptain) holder.is_captain = true;
    }
  }

  const players: OwnedPlayer[] = [];
  for (const p of squadIds) {
    const el = elementById.get(p.element);
    if (!el) continue;
    const purchase = purchasePriceFor(el, transfers, chipEvents);
    players.push({
      element: el,
      purchasePrice: purchase,
      sellPrice: sellingPrice(purchase, el.now_cost),
      pickPosition: p.position,
      isCaptain: p.is_captain,
      isViceCaptain: p.is_vice_captain,
    });
  }

  // FTs: banked from played GWs, minus any already spent on pending transfers
  // (unless a wildcard/free-hit is queued for the upcoming GW).
  let freeTransfers = computeFreeTransfers(history.current, chipEvents);
  const upcomingChip = nextEvent != null ? chipEvents.get(nextEvent) : undefined;
  if (pending.length > 0 && upcomingChip !== "wildcard" && upcomingChip !== "freehit") {
    freeTransfers = Math.max(0, freeTransfers - pending.length);
  }

  return {
    players,
    bank,
    freeTransfers,
    usedChips: history.chips.map((c) => c.name),
    activeChip: opts?.activeChip !== undefined ? opts.activeChip : picks.active_chip,
    currentEvent: opts?.displayEvent ?? picks.entry_history.event,
    nextEvent,
  };
}

/**
 * A 404 on an entry means different things in different months: during the
 * summer reset every last-season team ID is retired, so "check the ID" is
 * misleading. Look at the season state and explain what's actually going on.
 */
export async function entryNotFoundMessage(): Promise<string> {
  try {
    const b = await api.bootstrap();
    const seasonStarted = b.events.some((e) => e.finished);
    if (!seasonStarted) {
      return (
        "That ID isn't in FPL's system right now — and that's normal in pre-season: " +
        "FPL retires ALL team IDs over the summer. Register your squad for the new season " +
        "at fantasy.premierleague.com and you'll get a fresh ID (it appears in the URL once " +
        "your team is created). Meanwhile, feel free to explore the demo."
      );
    }
  } catch {
    // bootstrap unavailable — fall through to the generic message
  }
  return "No data found — check that the FPL ID is correct.";
}

export function fmtRank(rank: number | null | undefined): string {
  if (rank == null) return "–";
  return rank.toLocaleString("en-GB");
}

/**
 * Rank as the "top X%" label FPL itself started showing in 2026/27.
 * Precision follows the number: the top of the table needs decimals to say
 * anything at all, the middle doesn't. Returns null when it can't be computed.
 */
export function rankPercentile(
  rank: number | null | undefined,
  totalPlayers: number | null | undefined
): string | null {
  if (rank == null || !totalPlayers || totalPlayers <= 0 || rank <= 0) return null;
  const pct = Math.min(100, (rank / totalPlayers) * 100);
  const digits = pct < 0.1 ? 3 : pct < 1 ? 2 : pct < 10 ? 1 : 0;
  return `Top ${pct.toFixed(digits)}%`;
}

/** Locale-formatted integer (thousands separators). */
export function fmtNum(n: number | null | undefined): string {
  if (n == null) return "–";
  return n.toLocaleString("en-GB");
}

/** Official player headshot (110x140) from the Premier League CDN. */
export function playerPhotoUrl(el: { photo?: string }): string | null {
  if (!el.photo) return null;
  const id = el.photo.replace(/\.(jpg|png)$/i, "");
  return `https://resources.premierleague.com/premierleague/photos/players/110x140/p${id}.png`;
}

/** Club shirt image from the official FPL site. */
export function shirtUrl(team: { code?: number }, gk = false): string | null {
  if (!team.code) return null;
  return `https://fantasy.premierleague.com/dist/img/shirts/standard/shirt_${team.code}${gk ? "_1" : ""}-66.png`;
}
