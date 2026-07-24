// Season archive.
//
// FPL's public API only serves squad and per-player scoring data for the
// season that is currently running: `entry/{id}/event/{gw}/picks/` and
// `event/{gw}/live/` are reset when a new season starts, and the `past` array
// in `entry/{id}/history/` keeps nothing but the season name, the total points
// and the overall rank. That means a finished season's points can never be
// re-derived from the API afterwards.
//
// So we keep our own copy. Whenever the season breakdown is computed for the
// live season we store a compact, denormalised snapshot in localStorage. Names,
// positions and team codes are copied in rather than element ids, because FPL
// reassigns element ids every summer — an id archived today points at a
// different player next year.

import type { Element, Event, Team } from "./types";
import type { SeasonBreakdown } from "./breakdown";

export interface ArchivedPlayer {
  name: string;
  /** element_type 1–4 at the time of archiving. */
  pos: number;
  /** Team short name, e.g. "ARS". */
  team: string;
  total: number;
  apps: number;
  byCat: Record<string, number>;
}

export interface ArchivedSeason {
  /** "2025/26" — matches `season_name` in the FPL history payload. */
  season: string;
  entryId: number;
  savedAt: number;
  /** Gameweeks included in the snapshot. */
  gwsPlayed: number;
  catTotals: Record<string, number>;
  playersTotal: number;
  hits: number;
  players: ArchivedPlayer[];
}

const VERSION = 1;
const key = (entryId: number, season: string) =>
  `fpl-archive-v${VERSION}-${entryId}-${season.replace("/", "-")}`;

/**
 * Season label for the currently running game, in FPL's own "2025/26" form.
 * Derived from the first gameweek deadline: a season that kicks off in August
 * 2025 is 2025/26 regardless of when we happen to be looking at it.
 */
export function currentSeasonName(events: Event[]): string | null {
  const first = [...events].sort((a, b) => a.id - b.id)[0];
  if (!first?.deadline_time) return null;
  const d = new Date(first.deadline_time);
  if (Number.isNaN(d.getTime())) return null;
  // Deadlines for GW1 land in July/August; guard anyway in case of an oddity.
  const start = d.getUTCMonth() >= 5 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Compact a live breakdown into the archive shape. Pure. */
export function toArchive(
  entryId: number,
  season: string,
  bd: SeasonBreakdown,
  elements: Map<number, Element>,
  teams: Team[],
  savedAt: number
): ArchivedSeason {
  const teamShort = new Map(teams.map((t) => [t.id, t.short_name]));
  const players: ArchivedPlayer[] = [];
  for (const r of bd.rows) {
    if (r.total === 0 && r.apps === 0) continue;
    const el = elements.get(r.elementId);
    if (!el) continue;
    players.push({
      name: el.web_name,
      pos: el.element_type,
      team: teamShort.get(el.team) ?? "",
      total: r.total,
      apps: r.apps,
      byCat: { ...r.byCat },
    });
  }
  return {
    season,
    entryId,
    savedAt,
    gwsPlayed: bd.gws.length,
    catTotals: { ...bd.catTotals },
    playersTotal: bd.playersTotal,
    hits: bd.hits,
    players,
  };
}

/** Persist a snapshot, but never replace a fuller one with a thinner one. */
export function saveSeasonArchive(a: ArchivedSeason): void {
  try {
    const existing = loadSeasonArchive(a.entryId, a.season);
    if (existing && existing.gwsPlayed > a.gwsPlayed) return;
    localStorage.setItem(key(a.entryId, a.season), JSON.stringify(a));
  } catch {
    // storage full or unavailable — the archive is a bonus, never a hard fail
  }
}

export function loadSeasonArchive(entryId: number, season: string): ArchivedSeason | null {
  try {
    const raw = localStorage.getItem(key(entryId, season));
    if (!raw) return null;
    const a = JSON.parse(raw) as ArchivedSeason;
    return a && Array.isArray(a.players) ? a : null;
  } catch {
    return null;
  }
}
