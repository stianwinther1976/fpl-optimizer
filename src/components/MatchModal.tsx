"use client";

import type { Element, EventLive, Fixture, Team } from "@/lib/types";
import { matchMinute } from "@/lib/live";
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
  const liveNow = fixture.started && !fixture.finished;
  const statOf = new Map(live?.elements.map((e) => [e.id, e.stats]) ?? []);

  const inMatch = elements.filter(
    (e) => e.team === fixture.team_h || e.team === fixture.team_a
  );
  const mine = inMatch.filter((e) => squadIds.has(e.id));
  const top = inMatch
    .filter((e) => (statOf.get(e.id)?.minutes ?? 0) > 0 && !squadIds.has(e.id))
    .sort(
      (a, b) =>
        (statOf.get(b.id)?.total_points ?? 0) - (statOf.get(a.id)?.total_points ?? 0) ||
        (statOf.get(b.id)?.bps ?? 0) - (statOf.get(a.id)?.bps ?? 0)
    )
    .slice(0, 6);

  const hs = fixture.team_h_score ?? 0;
  const as = fixture.team_a_score ?? 0;
  const hClass = !fixture.started ? "" : hs > as ? "text-accent" : hs < as ? "text-danger" : "text-warn";
  const aClass = !fixture.started ? "" : as > hs ? "text-accent" : as < hs ? "text-danger" : "text-warn";

  const Row = ({ el }: { el: Element }) => {
    const s = statOf.get(el.id);
    return (
      <button
        onClick={() => onPlayerSelect(el)}
        type="button"
        className="flex w-full items-center gap-2.5 px-1 py-2 text-left text-sm hover:bg-panel-2/60 active:bg-panel-2"
      >
        <PlayerAvatar el={el} teamShort={teams.get(el.team)?.short_name} size="sm" center={false} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{el.web_name}</span>
          <span className="block text-[11px] text-muted">
            {teams.get(el.team)?.short_name}
            {s ? ` · ${s.minutes}' · bps ${s.bps}` : ""}
          </span>
        </span>
        <span className="shrink-0 font-mono font-bold">{s?.total_points ?? 0}</span>
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
                ? matchMinute(fixture)
                : fixture.kickoff_time
                  ? new Date(fixture.kickoff_time).toLocaleString("en-GB", {
                      weekday: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "TBC"}
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
              {mine.map((el) => (
                <Row key={el.id} el={el} />
              ))}
            </div>
          </div>
        )}

        {top.length > 0 && (
          <div className="mt-4">
            <div className="text-sm font-semibold">Top performers</div>
            <div className="mt-1 divide-y divide-border-c/60">
              {top.map((el) => (
                <Row key={el.id} el={el} />
              ))}
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
