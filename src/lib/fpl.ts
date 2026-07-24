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
  }[];
}

export interface PastSeason {
  points: number;
  minutes: number;
}

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
 * Recent start share for a set of players: fraction of each player's last
 * `lastN` recorded rounds they STARTED (element-summary endpoint). Fetched
 * with limited concurrency; failures are simply left out of the map.
 */
export async function fetchRecentStarts(
  ids: number[],
  lastN = 5,
  concurrency = 8,
  onProgress?: (done: number, total: number) => void
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
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
          const started = rows.filter((r) => (r.starts ?? 0) > 0).length;
          out.set(id, started / rows.length);
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
 * Last season's totals (points + minutes) per player, from element-summary's
 * history_past. The strongest pre-season signal there is: who actually played
 * and delivered last year. Bounded concurrency; failures left out.
 */
export async function fetchPastSeason(
  ids: number[],
  concurrency = 8,
  onProgress?: (done: number, total: number) => void
): Promise<Map<number, PastSeason>> {
  const out = new Map<number, PastSeason>();
  const queue = [...new Set(ids)];
  let done = 0;
  const worker = async () => {
    for (;;) {
      const id = queue.shift();
      if (id == null) return;
      try {
        const s = await api.elementSummary(id);
        const past = s.history_past;
        if (past && past.length > 0) {
          const last = past[past.length - 1]; // most recent completed season
          if (last.minutes > 0) out.set(id, { points: last.total_points, minutes: last.minutes });
        }
      } catch {
        // no data — model carries on with prices + ep_next
      }
      done++;
      onProgress?.(done, queue.length + done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return out;
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
