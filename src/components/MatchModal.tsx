"use client";

import type { Element, EventLive, Fixture, Team } from "@/lib/types";
import {
  fixtureLines,
  isInPlay,
  liveFixtureScore,
  liveMatchMinutes,
  matchMinute,
} from "@/lib/live";
import { kickoffLabel } from "@/lib/display";
import { PlayerAvatar } from "./Pitch";
import Sheet, { SheetClose } from "./Sheet";

export default function MatchModal({
  fixture,
  teams,
  live,
  squadIds,
  elements,
  onPlayerSelect,
  onClose,
}: {
  fixture: Fixture;
  teams: Map<number, Team>;
  live: EventLive | null;
  squadIds: Set<number>;
  elements: Element[];
  onPlayerSelect: (el: Element) => void;
  onClose: () => void;
}) {
  const home = teams.get(fixture.team_h);
  const away = teams.get(fixture.team_a);
  const liveNow = isInPlay(fixture);
  /*
   * THIS MATCH'S NUMBERS, NOT THE GAMEWEEK'S. `live.elements[].stats` is a
   * gameweek total, so in a double gameweek the leg-2 sheet listed players who
   * only appeared in leg 1, showed them at 180', and ranked "top performers in
   * this match" by two legs of BPS. Same family of defect as the one
   * `provisionalBonus` was rewritten to remove, still live one file over.
   */
  const statOf = fixtureLines(fixture, live, new Map(elements.map((e) => [e.id, e.team])));

  const inMatch = elements.filter(
    (e) => e.team === fixture.team_h || e.team === fixture.team_a
  );
  const mine = inMatch.filter((e) => squadIds.has(e.id));
  const top = inMatch
    .filter((e) => (statOf.get(e.id)?.minutes ?? 0) > 0 && !squadIds.has(e.id))
    .sort(
      (a, b) =>
        (statOf.get(b.id)?.points ?? 0) - (statOf.get(a.id)?.points ?? 0) ||
        (statOf.get(b.id)?.bps ?? 0) - (statOf.get(a.id)?.bps ?? 0)
    )
    .slice(0, 6);

  // The live feed carries a goal ahead of `fixtures/` — see `liveFixtureScore`.
  const derived = liveFixtureScore(live, fixture, new Map(elements.map((e) => [e.id, e])));
  const hs = derived?.h ?? fixture.team_h_score ?? 0;
  const as = derived?.a ?? fixture.team_a_score ?? 0;
  const hClass = !fixture.started ? "" : hs > as ? "text-accent" : hs < as ? "text-danger" : "text-warn";
  const aClass = !fixture.started ? "" : as > hs ? "text-accent" : as < hs ? "text-danger" : "text-warn";

  /*
   * A render function, not a component declared in render — see the long note
   * on the same pattern in `Pitch.tsx`. Declared as a component it is a new
   * type on every render, so React remounts every row and drops focus and any
   * per-row state with it. Lower blast radius here than in the squad list,
   * because this sheet does not poll, but the same defect.
   */
  const row = (el: Element) => {
    const s = statOf.get(el.id);
    return (
      <button
        key={el.id}
        onClick={() => onPlayerSelect(el)}
        type="button"
        className="flex w-full items-center gap-2.5 px-1 py-2 text-left text-sm hover:bg-panel-2/60 active:bg-panel-2"
      >
        <PlayerAvatar el={el} teamShort={teams.get(el.team)?.short_name} size="sm" center={false} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{el.web_name}</span>
          <span className="block text-[11px] text-muted">
            {teams.get(el.team)?.short_name}
            {s ? ` · ${s.minutes}'` : ""}
            {s && s.bps != null ? ` · bps ${s.bps}` : ""}
          </span>
        </span>
        <span className="shrink-0 font-mono font-bold">{s?.points ?? 0}</span>
      </button>
    );
  };

  return (
    <Sheet onClose={onClose} labelledBy="match-modal-title" maxWidth="max-w-md">
      <div>
        <div className="flex items-start justify-between gap-2">
          <div>
            <div id="match-modal-title" className="text-xl font-bold">
              <span className={hClass}>{home?.short_name}</span>{" "}
              {fixture.started ? (
                <>
                  <span className={hClass}>{hs}</span>
                  <span className="text-muted">–</span>
                  <span className={aClass}>{as}</span>
                </>
              ) : (
                <span className="text-muted">v</span>
              )}{" "}
              <span className={aClass}>{away?.short_name}</span>
            </div>
            <div className={`text-sm ${liveNow ? "font-semibold text-accent" : "text-muted"}`}>
              {fixture.started
                ? matchMinute(fixture, undefined, liveMatchMinutes(live, fixture.id))
                : kickoffLabel(fixture, (iso) =>
                          new Date(iso).toLocaleString("en-GB", {
                            weekday: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          }))}
              {" · "}
              {home?.name} v {away?.name}
            </div>
          </div>
          <SheetClose onClose={onClose} />
        </div>

        {mine.length > 0 && (
          <div className="mt-4">
            <div className="text-sm font-semibold text-accent">Your players in this match</div>
            <div className="mt-1 divide-y divide-border-c/60">
              {mine.map((el) => row(el))}
            </div>
          </div>
        )}

        {top.length > 0 && (
          <div className="mt-4">
            <div className="text-sm font-semibold">Top performers</div>
            <div className="mt-1 divide-y divide-border-c/60">
              {top.map((el) => row(el))}
            </div>
          </div>
        )}

        {mine.length === 0 && top.length === 0 && (
          <p className="mt-4 text-sm text-muted">No player data for this match yet.</p>
        )}
      </div>
    </Sheet>
  );
}
