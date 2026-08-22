"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { api, currentFeed, type ElementSummary } from "@/lib/fpl";
import type { Element, EventLive, Fixture, Team } from "@/lib/types";
import { fmtPrice, POSITION_NAMES } from "@/lib/rules";
import { teamFixtures } from "@/lib/xp";
import { readPriceChange } from "@/lib/priceChange";
import {
  activeStartCalls,
  setStartCall,
  startCallsVersion,
  subscribeStartCalls,
  type StartCall,
} from "@/lib/lineup";
import { Badge, PriceTrendBar } from "./ui";
import { PlayerAvatar } from "./Pitch";
import Sheet, { SheetClose } from "./Sheet";

const FDR_BADGE: Record<number, string> = {
  1: "bg-emerald-600 text-white",
  2: "bg-emerald-500/90 text-black",
  3: "bg-zinc-500 text-white",
  4: "bg-rose-500/90 text-white",
  5: "bg-rose-700 text-white",
};

const STAT_LABELS: Record<string, string> = {
  minutes: "Minutes played",
  goals_scored: "Goals scored",
  assists: "Assists",
  clean_sheets: "Clean sheet",
  goals_conceded: "Goals conceded",
  own_goals: "Own goals",
  penalties_saved: "Penalties saved",
  penalties_missed: "Penalties missed",
  saves: "Saves",
  yellow_cards: "Yellow card",
  red_cards: "Red card",
  bonus: "Bonus",
  defensive_contribution: "Defensive contribution",
};

export default function PlayerModal({
  element,
  team,
  live,
  event,
  gwFinished,
  onClose,
  fixtures = [],
  teams,
  nextEvent = null,
  multiplier = 1,
}: {
  element: Element;
  team: Team | undefined;
  live: EventLive | null;
  event: number | null;
  gwFinished: boolean;
  onClose: () => void;
  fixtures?: Fixture[];
  teams?: Map<number, Team>;
  nextEvent?: number | null;
  /**
   * What this player's score is multiplied by in the reader's team this
   * gameweek — 2 for the captain, 3 under Triple Captain, 1 otherwise.
   *
   * THE MODAL HAD NO IDEA THE ARMBAND EXISTED. Tapping a card reading "4 pts"
   * opened a sheet headed "2 pts", because the card applies the multiplier and
   * the modal printed `stats.total_points` raw. Both numbers are true and the
   * reader is given no way to know that.
   */
  multiplier?: number;
}) {
  // Re-render when the reader changes a call anywhere — the button state and
  // the note below it both have to follow the store rather than local state,
  // or two open sheets could disagree about the same player.
  const callsVersion = useSyncExternalStore(
    subscribeStartCalls,
    startCallsVersion,
    startCallsVersion
  );
  void callsVersion;
  const myCall = activeStartCalls().get(element.id) ?? null;
  const demo = currentFeed() === "demo";

  // Next three gameweeks of fixtures for this player's club.
  const upcoming: { gw: number; opp: string; home: boolean; fdr: number }[] = [];
  if (nextEvent != null && teams) {
    for (let gw = nextEvent; gw < nextEvent + 3; gw++) {
      for (const f of teamFixtures(fixtures, element.team, gw)) {
        const home = f.team_h === element.team;
        upcoming.push({
          gw,
          opp: teams.get(home ? f.team_a : f.team_h)?.short_name ?? "?",
          home,
          fdr: home ? f.team_h_difficulty : f.team_a_difficulty,
        });
      }
    }
  }
  const liveEl = live?.elements.find((e) => e.id === element.id) ?? null;
  const rows =
    liveEl?.explain?.flatMap((fx) => fx.stats).filter((s) => s.points !== 0 || s.identifier === "minutes") ??
    [];
  const total = liveEl?.stats.total_points ?? null;

  // Last five recorded gameweeks (lazy — one small request per opened player).
  const [recent, setRecent] = useState<ElementSummary["history"] | null>(null);
  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset while the new player's data loads
    setRecent(null);
    api
      .elementSummary(element.id)
      .then((s) => {
        if (!cancelled) setRecent([...s.history].slice(-5).reverse());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [element.id]);
  const startsKnown = recent?.some((r) => r.starts != null) ?? false;
  const startedCount = recent?.filter((r) => (r.starts ?? 0) > 0).length ?? 0;

  // Set-piece duty (public API: penalties + corner/free-kick order)
  const duties: string[] = [];
  if (element.penalties_order === 1) duties.push("Penalties: 1st taker");
  else if (element.penalties_order === 2) duties.push("Penalties: 2nd taker");
  const spOrder = Math.min(
    element.corners_and_indirect_freekicks_order ?? 99,
    element.direct_freekicks_order ?? 99
  );
  if (spOrder === 1) duties.push("Set pieces: 1st taker");
  else if (spOrder === 2) duties.push("Set pieces: 2nd taker");
  // Price-change pressure from net event transfers relative to ownership.
  const netTransfers = (element.transfers_in_event ?? 0) - (element.transfers_out_event ?? 0);
  // FPL's own predictor, when it has published a figure for this player.
  const price = readPriceChange(element);

  return (
    <Sheet onClose={onClose} labelledBy="player-modal-title" maxWidth="max-w-md">
      <div>
        <div className="flex items-start gap-3">
          <PlayerAvatar el={element} teamShort={team?.short_name} />
          <div className="min-w-0 flex-1">
            <div id="player-modal-title" className="truncate text-lg font-bold">
              {element.first_name} {element.second_name}
            </div>
            <div className="text-sm text-muted">
              {team?.name} · {POSITION_NAMES[element.element_type]} · £{fmtPrice(element.now_cost)}m
            </div>
            {element.news && <div className="mt-1 text-xs text-warn">{element.news}</div>}
            {(duties.length > 0 || netTransfers !== 0) && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {duties.map((d) => (
                  <Badge key={d} tone="purple">
                    {d}
                  </Badge>
                ))}
                {netTransfers > 25000 && <Badge tone="green">▲ {Math.round(netTransfers / 1000)}k in this GW</Badge>}
                {netTransfers < -25000 && <Badge tone="red">▼ {Math.round(-netTransfers / 1000)}k out this GW</Badge>}
              </div>
            )}
          </div>
          <SheetClose onClose={onClose} />
        </div>

        {/* GW point breakdown */}
        {event != null && liveEl && (
          <div className="mt-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">
                GW{event} points
                <span className="ml-2">
                  {gwFinished ? <Badge>Final</Badge> : <Badge tone="green">Live</Badge>}
                </span>
              </div>
              <div className={`text-right text-xl font-bold ${gwFinished ? "" : "text-accent"}`}>
                {total == null ? "–" : total * multiplier}{" "}
                {total != null && total * multiplier === 1 ? "pt" : "pts"}
                {multiplier > 1 && total != null && (
                  <div className="text-xs font-normal text-muted">
                    {multiplier}× {total} as {multiplier === 3 ? "triple captain" : "captain"}
                  </div>
                )}
              </div>
            </div>
            {rows.length > 0 ? (
              <table className="mt-2 w-full text-sm">
                <tbody className="divide-y divide-border-c/60">
                  {rows.map((s, i) => (
                    <tr key={i}>
                      <td className="py-1.5">{STAT_LABELS[s.identifier] ?? s.identifier}</td>
                      <td className="py-1.5 text-right font-mono text-muted">{s.value}</td>
                      <td
                        className={`w-14 py-1.5 text-right font-mono font-semibold ${
                          s.points > 0 ? "text-accent" : s.points < 0 ? "text-danger" : "text-muted"
                        }`}
                      >
                        {s.points > 0 ? `+${s.points}` : s.points}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="mt-2 text-sm text-muted">No point-scoring actions yet.</p>
            )}
          </div>
        )}

        {/* Recent gameweeks: the strongest minutes signal there is */}
        {recent && recent.length > 0 && (
          <div className="mt-4">
            <div className="text-sm font-semibold">
              Recent gameweeks
              {startsKnown && (
                <span className="ml-2 font-normal text-muted">
                  started {startedCount} of last {recent.length}
                </span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {/* `round` is NOT unique: a double gameweek gives one player two
                  history rows in the same round, and keying on it alone made
                  React reconcile the two chips as one. The opponent is the real
                  discriminator — a club cannot play the same opponent twice in
                  one gameweek — so this is an identity, not a position. */}
              {recent.map((r) => (
                <div
                  key={`${r.round}-${r.opponent_team}`}
                  className="flex items-center gap-1.5 rounded-lg bg-panel-2 px-2 py-1.5 text-xs"
                >
                  <span className="text-muted">GW{r.round}</span>
                  <span className={r.minutes === 0 ? "text-danger" : "text-muted"}>
                    {r.minutes}&apos;
                  </span>
                  <span
                    className={`font-mono font-bold ${
                      r.total_points >= 6 ? "text-accent" : r.total_points <= 1 ? "text-muted" : ""
                    }`}
                  >
                    {r.total_points}p
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Second opinion: FPL's own expected-points projection for the next GW */}
        {element.ep_next != null && parseFloat(element.ep_next) >= 0 && (
          <div className="mt-4 flex items-center justify-between rounded-lg border border-border-c bg-panel-2 px-3 py-2.5 text-sm">
            <span className="text-muted">
              FPL&apos;s own next-GW projection
              <span className="ml-1 text-[11px]">(an independent estimate)</span>
            </span>
            <span className="font-mono font-semibold">{parseFloat(element.ep_next).toFixed(1)} pts</span>
          </div>
        )}

        {/* FPL's Price Change Predictor. Only rendered when the feed carries a
            figure — silence is honest, "unlikely to change" on missing data isn't. */}
        {price && (
          <div className="mt-4">
            <div className="flex items-baseline justify-between gap-2">
              <div className="text-sm font-semibold">Price change</div>
              <div
                className={`text-sm font-semibold ${
                  price.direction === 1
                    ? "text-accent"
                    : price.direction === -1
                      ? "text-danger"
                      : "text-muted"
                }`}
              >
                {price.label}
              </div>
            </div>
            <PriceTrendBar percent={price.percent} />
            <p className="mt-1.5 text-xs text-muted">
              {Math.abs(price.percent).toFixed(0)}% of the way to a{" "}
              {price.percent >= 0 ? "rise" : "fall"}
              {price.imminent
                ? " — past the threshold, so FPL expects the move at the next 00:00 UK update."
                : ". Prices move at 00:00 UK, at most 0.1 a day."}
            </p>
          </div>
        )}

        {/* Upcoming fixtures (next 3 GWs, like the official FPL view) */}
        {upcoming.length > 0 && (
          <div className="mt-4">
            <div className="text-sm font-semibold">Upcoming fixtures</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {upcoming.map((u, i) => (
                <div
                  key={i}
                  className="flex items-center gap-1.5 rounded-lg bg-panel-2 px-2 py-1.5 text-xs"
                >
                  <span className="text-muted">GW{u.gw}</span>
                  <span className="font-semibold">
                    {u.opp} ({u.home ? "H" : "A"})
                  </span>
                  <span className={`rounded px-1 font-bold ${FDR_BADGE[u.fdr] ?? FDR_BADGE[3]}`}>
                    {u.fdr}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Team news the model cannot read */}
        <div className="mt-4">
          <div className="text-sm font-semibold">Do you know if he starts?</div>
          <p className="mt-1 text-xs text-muted">
            The model works this out from price, last season&apos;s starts and ownership.
            It has not seen a press conference. If you have, say so and the projection
            follows you.
          </p>
          <div className="mt-2 flex gap-2">
            {([
              ["starts", "Starts"],
              ["benched", "Not in the XI"],
            ] as [StartCall, string][]).map(([call, label]) => (
              <button
                key={call}
                type="button"
                aria-pressed={myCall === call}
                onClick={() => setStartCall(demo, element.id, myCall === call ? null : call)}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition ${
                  myCall === call
                    ? "border-accent bg-accent/15 text-accent"
                    : "border-border-c bg-panel-2 text-muted hover:border-accent"
                }`}
              >
                {myCall === call ? "✓ " : ""}
                {label}
              </button>
            ))}
          </div>
          {myCall && (
            <p className="mt-2 text-xs text-warn">
              You set this, not the model — {element.web_name}&apos;s NEXT gameweek follows
              it, and the model takes the rest of the horizon back. Tap again to hand him
              back entirely.
            </p>
          )}
        </div>

        {/* Season stats */}
        <div className="mt-4">
          <div className="text-sm font-semibold">Season</div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-center">
            {[
              ["Points", String(element.total_points)],
              ["Form", element.form],
              ["Owned", `${element.selected_by_percent}%`],
              ["Goals", String(element.goals_scored)],
              ["Assists", String(element.assists)],
              ["xGI", element.expected_goal_involvements],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg bg-panel-2 px-2 py-2">
                <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
                <div className="font-mono font-semibold">{value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Sheet>
  );
}
