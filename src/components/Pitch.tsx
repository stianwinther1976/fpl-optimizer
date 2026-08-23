"use client";

import { useEffect, useState } from "react";
import type { Element, Fixture, Team } from "@/lib/types";
import { fmtPrice } from "@/lib/rules";
import { teamFixtures } from "@/lib/xp";
import { playerPhotoUrl } from "@/lib/fpl";
import { captainXpLabel, scoreTier, type ScoreTier } from "@/lib/display";

export interface PitchPlayer {
  element: Element;
  xp?: number;
  isCaptain?: boolean;
  isVice?: boolean;
  sellPrice?: number;
  /**
   * Gameweek points to show under the card. `final` says the round is complete
   * — it no longer drives the COLOUR, which now says how much the number is
   * worth reading (see `scoreTier`); it is kept because callers still use it
   * for the running total beside the gameweek.
   */
  live?: { points: number; final: boolean };
  /**
   * The sub-priority badge on a bench card, or `null` for "this player has no
   * sub priority". Omit it and the badge is the card's position in the list.
   *
   * THE POSITION IS NOT ALWAYS THE PRIORITY. Once auto-substitutions are
   * applied the bench is "everyone not in the effective eleven", which includes
   * the starter who was subbed OFF — and he is not first in the queue to come
   * on, he is not in the queue at all. Numbering by list position labelled him
   * "1", i.e. the very next player to be brought on, under a heading that says
   * "in order". `null` is the only honest badge there, so it gets one.
   */
  benchOrder?: number | null;
}

/*
 * ONE STEP OF EMPHASIS PER STEP OF MEANING.
 *
 * Weight carries as much of this as colour, on purpose: a blank drops to
 * regular weight and recedes, a return goes bold and green and comes forward.
 * That way the list still reads correctly for someone who cannot separate the
 * green from the grey, which colour alone would not.
 *
 * Two maps because the two views sit on different grounds. The pitch card is a
 * translucent black overlay on a photographic background, where the theme's
 * `muted` has too little contrast, so it uses fixed light values. The list sits
 * on the panel and uses the theme tokens, which are defined for both schemes.
 */
const PITCH_TIER: Record<ScoreTier, string> = {
  negative: "font-bold text-[#ff5c8a]",
  blank: "text-zinc-400",
  played: "text-zinc-100",
  returned: "font-bold text-[#00ff87]",
};

const LIST_TIER: Record<ScoreTier, string> = {
  negative: "font-bold text-danger",
  blank: "text-muted",
  played: "",
  returned: "font-bold text-accent",
};

const TYPE_COLORS: Record<number, string> = {
  1: "bg-amber-500",
  2: "bg-sky-500",
  3: "bg-emerald-500",
  4: "bg-rose-500",
};

// What the line under each player shows (FPL-style squad view options).
export type PitchInfoMode = "auto" | "price" | "xp" | "form" | "own" | "fdr";

const FDR_BADGE: Record<number, string> = {
  1: "bg-emerald-600 text-white",
  2: "bg-emerald-500/90 text-black",
  3: "bg-zinc-500 text-white",
  4: "bg-rose-500/90 text-white",
  5: "bg-rose-700 text-white",
};

function statusFlag(el: Element): string | null {
  if (el.status === "i") return "🤕";
  if (el.status === "s") return "🚫";
  if (el.status === "d") return "⚠️";
  if (el.status === "u" || el.status === "n") return "❌";
  return null;
}

export function PlayerAvatar({
  el,
  teamShort,
  size = "md",
  center = true,
}: {
  el: Element;
  teamShort?: string;
  size?: "sm" | "md";
  center?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const url = playerPhotoUrl(el);
  const dims = `${size === "sm" ? "h-7 w-7" : "h-10 w-10 sm:h-12 sm:w-12"} ${center ? "mx-auto" : "shrink-0"}`;
  if (url && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- external CDN, no next/image config needed
      <img
        src={url}
        alt={el.web_name}
        loading="lazy"
        onError={() => setFailed(true)}
        className={`${dims} rounded-full bg-panel-2 object-cover object-top shadow`}
      />
    );
  }
  return (
    <div
      className={`flex ${dims} items-center justify-center rounded-full ${TYPE_COLORS[el.element_type]} ${size === "sm" ? "text-[10px]" : "text-sm"} font-bold text-black shadow`}
    >
      {teamShort?.slice(0, 3) ?? "?"}
    </div>
  );
}

function PlayerCard({
  p,
  teams,
  fixtures,
  nextEvent,
  fixtureEvent,
  statusOf,
  onSelect,
  info = "auto",
}: {
  p: PitchPlayer;
  teams: Map<number, Team>;
  fixtures: Fixture[];
  nextEvent: number | null;
  /**
   * The gameweek whose fixture the opponent line names, when that is NOT the
   * one being planned for.
   *
   * A CARD MUST NOT MIX TWO GAMEWEEKS. While a gameweek is live the card shows
   * that gameweek's points, and the opponent line under it was still naming the
   * NEXT one's fixture — so Caicedo read "7 pts" beside "BHA (H)" for a Chelsea
   * side playing Fulham that afternoon. Reported, and correct in both halves
   * separately, which is what made it hard to see.
   *
   * The FDR strip deliberately keeps reading `nextEvent`: it is the planning
   * view and is meant to look forward.
   */
  fixtureEvent?: number | null;
  /**
   * "Done (90)", "45'", "Did not play", or a kick-off time — where this player
   * is in the gameweek the card is showing. See `playerMatchStatus`.
   *
   * A squad view tells you the score; without this it cannot tell you whether
   * that score is SETTLED, and nine points with everyone done is a different
   * position from nine with three still to kick off.
   */
  statusOf?: (el: Element) => string | null;
  onSelect?: (el: Element) => void;
  info?: PitchInfoMode;
}) {
  const el = p.element;
  const team = teams.get(el.team);
  const flag = statusFlag(el);
  // The gameweek the rest of this card is about. See `fixtureEvent`.
  const fxEvent = fixtureEvent ?? nextEvent;
  const status = statusOf?.(el) ?? null;
  const fx =
    fxEvent != null
      ? teamFixtures(fixtures, el.team, fxEvent)
          .map((f) => {
            const home = f.team_h === el.team;
            const opp = teams.get(home ? f.team_a : f.team_h);
            return `${opp?.short_name ?? "?"} (${home ? "H" : "A"})`;
          })
          .join(", ")
      : "";

  const Tag = onSelect ? "button" : "div";
  return (
    <Tag
      type={onSelect ? "button" : undefined}
      className={`relative w-[4.6rem] max-w-full text-center sm:w-24 ${onSelect ? "cursor-pointer active:scale-[0.98]" : ""}`}
      title={el.news || undefined}
      onClick={onSelect ? () => onSelect(el) : undefined}
    >
      {p.isCaptain && (
        <span className="absolute -top-1 -right-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-black text-[10px] font-bold text-white ring-1 ring-white/40">
          C
        </span>
      )}
      {p.isVice && (
        <span className="absolute -top-1 -right-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-600 text-[10px] font-bold text-white ring-1 ring-white/30">
          V
        </span>
      )}
      <PlayerAvatar el={el} teamShort={team?.short_name} />
      <div className="mt-1 truncate rounded bg-black/70 px-1 py-0.5 text-[11px] font-semibold leading-tight text-white">
        {flag ? `${flag} ` : ""}
        {el.web_name}
      </div>
      <div className={`truncate ${fx ? "" : "rounded-b"} bg-black/50 px-1 py-0.5 text-[10px] text-zinc-300`}>
        {info === "auto" && (
          <>
            {p.live ? (
              <span className={PITCH_TIER[scoreTier(p.live.points)]}>
                {p.live.points} {p.live.points === 1 ? "pt" : "pts"}
              </span>
            ) : (
              <>£{fmtPrice(el.now_cost)}m</>
            )}
            {p.xp != null && !p.live && (
              <span className="text-[#00ff87]"> · {captainXpLabel(p.xp, !!p.isCaptain)}</span>
            )}
          </>
        )}
        {info === "price" && <>£{fmtPrice(el.now_cost)}m</>}
        {info === "xp" && (
          <span className="text-[#00ff87]">
            {p.xp != null ? captainXpLabel(p.xp, !!p.isCaptain) : "–"}
          </span>
        )}
        {info === "form" && <>Form {el.form}</>}
        {info === "own" && <>{el.selected_by_percent}%</>}
        {info === "fdr" &&
          (() => {
            // Next three gameweeks, one badge per fixture (like FPL's view).
            const fdrs: number[] = [];
            if (nextEvent != null) {
              for (let gw = nextEvent; gw < nextEvent + 3; gw++) {
                for (const f of teamFixtures(fixtures, el.team, gw)) {
                  fdrs.push(f.team_h === el.team ? f.team_h_difficulty : f.team_a_difficulty);
                }
              }
            }
            return fdrs.length === 0 ? (
              <>BLANK</>
            ) : (
              <span className="inline-flex gap-0.5">
                {/* Three, matching the List view and the three-gameweek scan
                    above it. Four badges from a three-gameweek scan made the
                    two layouts disagree in a double gameweek. */}
                {fdrs.slice(0, 3).map((d, i) => (
                  <span
                    key={i}
                    className={`rounded px-1 font-bold ${FDR_BADGE[d] ?? FDR_BADGE[3]}`}
                  >
                    {d}
                  </span>
                ))}
              </span>
            );
          })()}
      </div>
      {fx && (
        <div
          className={`truncate ${status ? "" : "rounded-b"} bg-black/50 px-1 py-0.5 text-[10px] text-zinc-200`}
          title={fx}
        >
          {fx}
        </div>
      )}
      {status && (
        <div
          className="truncate rounded-b bg-black/60 px-1 py-0.5 text-[10px] text-zinc-300"
          title={status}
        >
          {status}
        </div>
      )}
    </Tag>
  );
}

/** The number on a bench card: the caller's, or the card's place in the list. */
function benchBadge(p: PitchPlayer, i: number): number | null {
  return p.benchOrder === undefined ? i + 1 : p.benchOrder;
}

export default function Pitch({
  starters,
  bench,
  teams,
  fixtures,
  nextEvent,
  fixtureEvent,
  statusOf,
  formation,
  onSelect,
  cornerTotal,
}: {
  starters: PitchPlayer[];
  bench: PitchPlayer[];
  teams: Map<number, Team>;
  fixtures: Fixture[];
  nextEvent: number | null;
  /**
   * The gameweek whose fixture the opponent line names, when that is NOT the
   * one being planned for.
   *
   * A CARD MUST NOT MIX TWO GAMEWEEKS. While a gameweek is live the card shows
   * that gameweek's points, and the opponent line under it was still naming the
   * NEXT one's fixture — so Caicedo read "7 pts" beside "BHA (H)" for a Chelsea
   * side playing Fulham that afternoon. Reported, and correct in both halves
   * separately, which is what made it hard to see.
   *
   * The FDR strip deliberately keeps reading `nextEvent`: it is the planning
   * view and is meant to look forward.
   */
  fixtureEvent?: number | null;
  /**
   * "Done (90)", "45'", "Did not play", or a kick-off time — where this player
   * is in the gameweek the card is showing. See `playerMatchStatus`.
   *
   * A squad view tells you the score; without this it cannot tell you whether
   * that score is SETTLED, and nine points with everyone done is a different
   * position from nine with three still to kick off.
   */
  statusOf?: (el: Element) => string | null;
  formation?: [number, number, number];
  onSelect?: (el: Element) => void;
  /** Total GW points shown in the top-left corner of the pitch */
  cornerTotal?: { title: string; points: number; final: boolean } | null;
}) {
  const rows: PitchPlayer[][] = [];
  const gk = starters.filter((p) => p.element.element_type === 1);
  const def = starters.filter((p) => p.element.element_type === 2);
  const mid = starters.filter((p) => p.element.element_type === 3);
  const fwd = starters.filter((p) => p.element.element_type === 4);
  rows.push(gk, def, mid, fwd);

  // FPL-style "view as" selector for the info line under each player.
  const [info, setInfo] = useState<PitchInfoMode>("auto");
  // Pitch (default) vs list/table layout — persisted like the info mode.
  const [layout, setLayout] = useState<"pitch" | "list">("pitch");
  useEffect(() => {
    const saved = localStorage.getItem("pitch-info");
    const savedLayout = localStorage.getItem("pitch-layout");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring persisted prefs on mount
    if (saved) setInfo(saved as PitchInfoMode);
     
    if (savedLayout === "list" || savedLayout === "pitch") setLayout(savedLayout);
  }, []);
  function changeInfo(v: PitchInfoMode) {
    setInfo(v);
    try {
      localStorage.setItem("pitch-info", v);
    } catch {}
  }
  function changeLayout(v: "pitch" | "list") {
    setLayout(v);
    try {
      localStorage.setItem("pitch-layout", v);
    } catch {}
  }

  const infoSelect = (
    <select
      value={info}
      onChange={(e) => changeInfo(e.target.value as PitchInfoMode)}
      aria-label="What to show for each player"
      className="min-h-11 rounded-lg border border-border-c bg-panel-2 px-2 py-1.5 text-[11px] font-semibold"
    >
      <option value="auto">Points</option>
      <option value="price">Price</option>
      <option value="xp">xP</option>
      <option value="form">Form</option>
      <option value="own">Ownership</option>
      <option value="fdr">FDR</option>
    </select>
  );

  return (
    <div>
      {/* Layout toggle (pitch / list) + metric selector */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex rounded-lg bg-panel-2 p-0.5 text-xs font-semibold">
          {(["pitch", "list"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => changeLayout(v)}
              /*
               * WHICH ONE IS SELECTED WAS ENCODED IN THE BACKGROUND COLOUR AND
               * NOWHERE ELSE. The two buttons differ only by `btn-primary`
               * versus `text-muted`, so in the accessibility tree they were
               * indistinguishable — a screen reader announced two buttons and
               * no state, and the app's own rule elsewhere is that colour is
               * never the only encoding of meaning.
               */
              aria-pressed={layout === v}
              // min-h-11: measured 28px at 390px, under any usable tap target,
              // and it sits directly above the pitch it controls.
              className={`min-h-11 rounded-md px-3 py-1.5 ${layout === v ? "btn-primary" : "text-muted"}`}
            >
              {v === "pitch" ? "⚽ Pitch" : "☰ List"}
            </button>
          ))}
        </div>
        {infoSelect}
      </div>

      {layout === "pitch" ? (
        <>
          <div className="pitch-bg relative rounded-xl px-1 py-3 sm:p-6">
            {cornerTotal && (
              <div className="absolute left-2 top-2 z-10 rounded-lg bg-black/70 px-2.5 py-1 text-center shadow">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-300">
                  {cornerTotal.title}
                </div>
                <div
                  className={`text-lg font-bold leading-tight ${
                    cornerTotal.final ? "text-white" : "text-[#00ff87]"
                  }`}
                >
                  {cornerTotal.points}
                  <span className="ml-0.5 text-[10px] font-medium text-zinc-300">pts</span>
                </div>
              </div>
            )}
            {formation && (
              <div className="mb-2 text-center text-xs font-semibold text-emerald-200/80">
                Formation {formation.join("-")}
              </div>
            )}
            <div className="flex flex-col gap-2.5 sm:gap-6">
              {rows.map((row, i) => (
                <div key={i} className="flex justify-center gap-1 sm:gap-6">
                  {row.map((p) => (
                    <PlayerCard
                      key={p.element.id}
                      p={p}
                      teams={teams}
                      fixtures={fixtures}
                      nextEvent={nextEvent}
                      fixtureEvent={fixtureEvent}
                      statusOf={statusOf}
                      onSelect={onSelect}
                      info={info}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
          {bench.length > 0 && (
            <div className="mt-2 rounded-xl border border-border-c bg-panel-2 p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                Bench (in order)
              </div>
              <div className="grid grid-cols-4 gap-1 sm:flex sm:justify-start sm:gap-6">
                {bench.map((p, i) => (
                  <div key={p.element.id} className="relative min-w-0">
                    {benchBadge(p, i) != null && (
                      <span className="absolute -top-1 left-0 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-[9px] font-bold text-white">
                        {benchBadge(p, i)}
                      </span>
                    )}
                    <PlayerCard
                      p={p}
                      teams={teams}
                      fixtures={fixtures}
                      nextEvent={nextEvent}
                      fixtureEvent={fixtureEvent}
                      statusOf={statusOf}
                      onSelect={onSelect}
                      info={info}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <ListView
          starters={starters}
          bench={bench}
          teams={teams}
          fixtures={fixtures}
          nextEvent={nextEvent}
          fixtureEvent={fixtureEvent}
          statusOf={statusOf}
          info={info}
          onSelect={onSelect}
          cornerTotal={cornerTotal}
        />
      )}
    </div>
  );
}

/** Table layout — every player and the selected metric in one scannable list. */
function ListView({
  starters,
  bench,
  teams,
  fixtures,
  nextEvent,
  fixtureEvent,
  statusOf,
  info,
  onSelect,
  cornerTotal,
}: {
  starters: PitchPlayer[];
  bench: PitchPlayer[];
  teams: Map<number, Team>;
  fixtures: Fixture[];
  nextEvent: number | null;
  /** See `PlayerCard`. The list names the same fixture the cards do. */
  fixtureEvent?: number | null;
  /** See `PlayerCard`. The list answers the same question the cards do. */
  statusOf?: (el: Element) => string | null;
  info: PitchInfoMode;
  onSelect?: (el: Element) => void;
  cornerTotal?: { title: string; points: number; final: boolean } | null;
}) {
  const POS = ["GK", "DEF", "MID", "FWD"];
  const groups: { label: string; type: number }[] = [
    { label: "Goalkeeper", type: 1 },
    { label: "Defenders", type: 2 },
    { label: "Midfielders", type: 3 },
    { label: "Forwards", type: 4 },
  ];

  const fixtureStr = (el: Element): string => {
    const ev = fixtureEvent ?? nextEvent;
    if (ev == null) return "";
    return teamFixtures(fixtures, el.team, ev)
      .map((f) => {
        const home = f.team_h === el.team;
        return `${teams.get(home ? f.team_a : f.team_h)?.short_name ?? "?"} (${home ? "H" : "A"})`;
      })
      .join(", ");
  };

  const metric = (p: PitchPlayer) => {
    const el = p.element;
    if (info === "price") return <>£{fmtPrice(el.now_cost)}m</>;
    if (info === "xp")
      return (
        <span className="text-accent">
          {p.xp != null ? captainXpLabel(p.xp, !!p.isCaptain) : "–"}
        </span>
      );
    if (info === "form") return <>{el.form}</>;
    if (info === "own") return <>{el.selected_by_percent}%</>;
    if (info === "fdr") {
      const fdrs: number[] = [];
      if (nextEvent != null)
        for (let gw = nextEvent; gw < nextEvent + 3; gw++)
          for (const f of teamFixtures(fixtures, el.team, gw))
            fdrs.push(f.team_h === el.team ? f.team_h_difficulty : f.team_a_difficulty);
      return fdrs.length === 0 ? (
        <span className="text-muted">–</span>
      ) : (
        <span className="inline-flex gap-0.5">
          {fdrs.slice(0, 3).map((d, i) => (
            <span key={i} className={`rounded px-1 text-[11px] font-bold ${FDR_BADGE[d] ?? FDR_BADGE[3]}`}>
              {d}
            </span>
          ))}
        </span>
      );
    }
    // auto
    if (p.live)
      return (
        <span className={LIST_TIER[scoreTier(p.live.points)]}>
          {p.live.points} {p.live.points === 1 ? "pt" : "pts"}
        </span>
      );
    return (
      <span>
        £{fmtPrice(el.now_cost)}m
        {p.xp != null && (
          <span className="ml-1 text-accent"> · {captainXpLabel(p.xp, !!p.isCaptain)}</span>
        )}
      </span>
    );
  };

  /*
   * A RENDER FUNCTION, NOT A COMPONENT DECLARED IN RENDER.
   *
   * `const Row = (...) => ...` inside this body creates a NEW component type on
   * every render, so React cannot match it to the previous one and unmounts and
   * remounts every row. Confirmed in a browser: after one 30-second live poll,
   * 0 of 15 tagged row nodes survived and focus had fallen back to `<body>`.
   * The pitch layout, whose card is a module-level component, kept 15 of 15.
   *
   * The cost is not just churn. Keyboard focus is dropped every poll during a
   * live gameweek, `PlayerAvatar`'s `failed` state resets so a photo that 404'd
   * flips back to a broken `<img>`, and an open sheet's focus-restore target is
   * a detached node.
   *
   * Calling it as a plain function inlines the JSX instead: the element types
   * React sees are the same ones as last render, so reconciliation works. That
   * is why this is not a component and must not become one again — hoisting it
   * to module level would also work but means threading `teams`, `metric`,
   * `fixtureStr` and `onSelect` through props for no gain.
   */
  const row = (p: PitchPlayer, benchNo?: number | null) => {
    const el = p.element;
    const flag = statusFlag(el);
    const fx = fixtureStr(el);
    const Tag = onSelect ? "button" : "div";
    return (
      <Tag
        key={el.id}
        type={onSelect ? "button" : undefined}
        onClick={onSelect ? () => onSelect(el) : undefined}
        className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${onSelect ? "hover:bg-panel-2/60 active:bg-panel-2" : ""}`}
      >
        {benchNo != null && (
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-panel-2 text-[9px] font-bold text-muted">
            {benchNo}
          </span>
        )}
        <PlayerAvatar el={el} teamShort={teams.get(el.team)?.short_name} size="sm" center={false} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 truncate text-sm font-medium">
            {flag && <span title={el.news}>{flag}</span>}
            {el.web_name}
            {p.isCaptain && (
              <span className="rounded-full bg-black px-1 text-[9px] font-bold text-white ring-1 ring-white/40">
                C
              </span>
            )}
            {p.isVice && (
              <span className="rounded-full bg-zinc-600 px-1 text-[9px] font-bold text-white">V</span>
            )}
          </span>
          <span className="block truncate text-[11px] text-muted">
            {teams.get(el.team)?.short_name}
            {fx ? ` · ${fx}` : ""}
            {/* Whether the score is SETTLED, which the points alone cannot say. */}
            {statusOf?.(el) ? ` · ${statusOf(el)}` : ""}
          </span>
        </span>
        <span className="shrink-0 whitespace-nowrap text-right font-mono text-sm">{metric(p)}</span>
      </Tag>
    );
  };

  return (
    <div className="overflow-hidden rounded-xl border border-border-c">
      {cornerTotal && (
        <div className="flex items-center justify-between border-b border-border-c bg-panel-2 px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">
            {cornerTotal.title}
          </span>
          <span className={`font-bold ${cornerTotal.final ? "" : "text-accent"}`}>
            {cornerTotal.points} pts
          </span>
        </div>
      )}
      {groups.map((g) => {
        const players = starters.filter((p) => p.element.element_type === g.type);
        if (players.length === 0) return null;
        return (
          <div key={g.type}>
            <div className="bg-panel-2/50 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
              {g.label}
            </div>
            <div className="divide-y divide-border-c/60">
              {players.map((p) => row(p))}
            </div>
          </div>
        );
      })}
      {bench.length > 0 && (
        <div>
          <div className="bg-panel-2/50 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
            Bench {POS.length ? "(in order)" : ""}
          </div>
          <div className="divide-y divide-border-c/60">
            {bench.map((p, i) => row(p, benchBadge(p, i)))}
          </div>
        </div>
      )}
    </div>
  );
}
