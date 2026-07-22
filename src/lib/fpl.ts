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

export class FplApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api/fpl/${path}`);
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
};

export interface TeamData {
  bootstrap: Bootstrap;
  fixtures: Fixture[];
  entry: Entry;
  picks: EntryEventPicks | null;
  history: EntryHistory;
  transfers: Transfer[];
  squad: SquadState | null;
}

/** Load everything needed for the dashboard for one FPL ID. */
export async function loadTeamData(id: number): Promise<TeamData> {
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

  const squad = picks ? buildSquadState(bootstrap, entry, picks, history, transfers) : null;
  return { bootstrap, fixtures, entry, picks, history, transfers, squad };
}

export function buildSquadState(
  bootstrap: Bootstrap,
  entry: Entry,
  picks: EntryEventPicks,
  history: EntryHistory,
  transfers: Transfer[]
): SquadState {
  const elementById = new Map(bootstrap.elements.map((e) => [e.id, e]));
  const players: OwnedPlayer[] = [];
  for (const p of picks.picks) {
    const el = elementById.get(p.element);
    if (!el) continue;
    const purchase = purchasePriceFor(el, transfers);
    players.push({
      element: el,
      purchasePrice: purchase,
      sellPrice: sellingPrice(purchase, el.now_cost),
      pickPosition: p.position,
      isCaptain: p.is_captain,
      isViceCaptain: p.is_vice_captain,
    });
  }

  const chipEvents = new Map(history.chips.map((c) => [c.event, c.name]));
  const freeTransfers = computeFreeTransfers(history.current, chipEvents);

  const nextEvent =
    bootstrap.events.find((e) => e.is_next)?.id ??
    (picks.entry_history.event < bootstrap.events.length ? picks.entry_history.event + 1 : null);

  return {
    players,
    bank: picks.entry_history.bank,
    freeTransfers,
    usedChips: history.chips.map((c) => c.name),
    activeChip: picks.active_chip,
    currentEvent: picks.entry_history.event,
    nextEvent,
  };
}

export function fmtRank(rank: number | null | undefined): string {
  if (rank == null) return "–";
  return rank.toLocaleString("en-GB");
}
