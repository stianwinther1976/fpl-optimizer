"use client";

import { useState } from "react";
import type { Element, Fixture, Team } from "@/lib/types";
import { fmtPrice } from "@/lib/rules";
import { teamFixtures } from "@/lib/xp";
import { playerPhotoUrl } from "@/lib/fpl";

export interface PitchPlayer {
  element: Element;
  xp?: number;
  isCaptain?: boolean;
  isVice?: boolean;
  sellPrice?: number;
}

const TYPE_COLORS: Record<number, string> = {
  1: "bg-amber-500",
  2: "bg-sky-500",
  3: "bg-emerald-500",
  4: "bg-rose-500",
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
}: {
  el: Element;
  teamShort?: string;
  size?: "sm" | "md";
}) {
  const [failed, setFailed] = useState(false);
  const url = playerPhotoUrl(el);
  const dims = size === "sm" ? "h-7 w-7" : "h-10 w-10 sm:h-12 sm:w-12";
  if (url && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- external CDN, no next/image config needed
      <img
        src={url}
        alt={el.web_name}
        loading="lazy"
        onError={() => setFailed(true)}
        className={`mx-auto ${dims} rounded-full bg-panel-2 object-cover object-top shadow`}
      />
    );
  }
  return (
    <div
      className={`mx-auto flex ${dims} items-center justify-center rounded-full ${TYPE_COLORS[el.element_type]} ${size === "sm" ? "text-[10px]" : "text-sm"} font-bold text-black shadow`}
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
}: {
  p: PitchPlayer;
  teams: Map<number, Team>;
  fixtures: Fixture[];
  nextEvent: number | null;
}) {
  const el = p.element;
  const team = teams.get(el.team);
  const flag = statusFlag(el);
  const fx =
    nextEvent != null
      ? teamFixtures(fixtures, el.team, nextEvent)
          .map((f) => {
            const home = f.team_h === el.team;
            const opp = teams.get(home ? f.team_a : f.team_h);
            return `${opp?.short_name ?? "?"} (${home ? "H" : "A"})`;
          })
          .join(", ")
      : "";

  return (
    <div className="relative w-[4.6rem] sm:w-24 text-center" title={el.news || undefined}>
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
      <div className="mt-1 truncate rounded bg-black/70 px-1 py-0.5 text-[11px] font-semibold leading-tight">
        {flag ? `${flag} ` : ""}
        {el.web_name}
      </div>
      <div className="truncate rounded-b bg-black/50 px-1 py-0.5 text-[10px] text-zinc-300">
        £{fmtPrice(el.now_cost)}
        {p.xp != null && <span className="text-accent"> · {p.xp.toFixed(1)}xp</span>}
      </div>
      {fx && (
        <div className="truncate text-[9px] text-zinc-400" title={fx}>
          {fx || "No fixture"}
        </div>
      )}
    </div>
  );
}

export default function Pitch({
  starters,
  bench,
  teams,
  fixtures,
  nextEvent,
  formation,
}: {
  starters: PitchPlayer[];
  bench: PitchPlayer[];
  teams: Map<number, Team>;
  fixtures: Fixture[];
  nextEvent: number | null;
  formation?: [number, number, number];
}) {
  const rows: PitchPlayer[][] = [];
  const gk = starters.filter((p) => p.element.element_type === 1);
  const def = starters.filter((p) => p.element.element_type === 2);
  const mid = starters.filter((p) => p.element.element_type === 3);
  const fwd = starters.filter((p) => p.element.element_type === 4);
  rows.push(gk, def, mid, fwd);

  return (
    <div>
      <div className="pitch-bg rounded-xl px-1 py-4 sm:p-6">
        {formation && (
          <div className="mb-2 text-center text-xs font-semibold text-emerald-200/80">
            Formation {formation.join("-")}
          </div>
        )}
        <div className="flex flex-col gap-4 sm:gap-6">
          {rows.map((row, i) => (
            <div key={i} className="flex justify-center gap-1 sm:gap-6">
              {row.map((p) => (
                <PlayerCard
                  key={p.element.id}
                  p={p}
                  teams={teams}
                  fixtures={fixtures}
                  nextEvent={nextEvent}
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
          <div className="flex justify-start gap-2 sm:gap-6 overflow-x-auto">
            {bench.map((p, i) => (
              <div key={p.element.id} className="flex items-end gap-1">
                <span className="pb-4 text-[10px] text-muted">{i + 1}.</span>
                <PlayerCard p={p} teams={teams} fixtures={fixtures} nextEvent={nextEvent} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
