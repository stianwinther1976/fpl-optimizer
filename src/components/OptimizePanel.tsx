"use client";

import { useEffect, useMemo, useState } from "react";
import type { TeamData } from "@/lib/fpl";
import { optimize, buildLaunchSquad, type LaunchSquad, type OptimizerResult } from "@/lib/optimizer";
import { fmtPrice, remainingChips, CHIP_LABELS } from "@/lib/rules";
import { Badge, SectionTitle } from "./ui";
import Pitch from "./Pitch";
import Sheet, { SheetClose } from "./Sheet";

/** Compact deadline countdown so the decision-critical time lives where the
 * decisions are made. */
function DeadlineNote({ gw, deadline }: { gw: number; deadline: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!deadline) return null;
  const ms = new Date(deadline).getTime() - now;
  if (ms <= 0) return null;
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const txt = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  const urgent = ms < 24 * 3_600_000;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${
        urgent ? "border-warn/50 bg-warn/10 text-warn" : "border-accent/40 bg-accent/10 text-accent"
      }`}
    >
      ⏰ GW{gw} deadline: {txt}
    </span>
  );
}

export default function OptimizePanel({
  data,
  onSelect,
}: {
  data: TeamData;
  onSelect?: (el: import("@/lib/types").Element) => void;
}) {
  const [horizon, setHorizon] = useState(5);
  const [result, setResult] = useState<OptimizerResult | null>(null);
  const [running, setRunning] = useState(false);
  const [view, setView] = useState<"plans" | "xi" | "dream">("plans");
  const [infoOpen, setInfoOpen] = useState<{ title: string; body: string[] } | null>(null);
  const [launch, setLaunch] = useState<LaunchSquad | null>(null);
  const [launchRunning, setLaunchRunning] = useState(false);

  const squad = data.squad;
  const teams = useMemo(
    () => new Map(data.bootstrap.teams.map((t) => [t.id, t])),
    [data.bootstrap]
  );

  const upcomingEvent = data.bootstrap.events.find((e) => e.is_next)?.id ?? null;

  // Season-launch mode: no squad yet (pre-GW1) but the new season's data is live.
  if ((!squad || squad.nextEvent == null) && upcomingEvent != null) {
    const runLaunch = () => {
      setLaunchRunning(true);
      setTimeout(() => {
        try {
          setLaunch(buildLaunchSquad(data.bootstrap, data.fixtures, upcomingEvent, 5));
        } finally {
          setLaunchRunning(false);
        }
      }, 30);
    };
    return (
      <div className="space-y-4">
        <div className="card p-5">
          <div className="text-lg font-bold">🚀 Season launch: build your £100m squad</div>
          <p className="mt-1 text-sm text-muted">
            No squad registered yet — perfect timing. Based on the new season&apos;s prices,
            FPL&apos;s own projections, team strengths and the opening fixtures (GW
            {upcomingEvent}–{upcomingEvent + 4}), the optimizer can draft the strongest legal
            15-man squad within the £100.0m budget: 2 GK, 5 DEF, 5 MID, 3 FWD, max 3 per club.
          </p>
          <button onClick={runLaunch} disabled={launchRunning} className="btn-primary mt-3 rounded-lg px-5 py-2.5">
            {launchRunning ? "Drafting…" : launch ? "Re-draft" : "Build my launch squad"}
          </button>
        </div>

        {launch && (
          <>
            <div className="card flex flex-wrap items-center gap-4 p-4 text-sm">
              <div>
                <span className="text-muted">Squad cost:</span>{" "}
                <b>£{fmtPrice(launch.cost)}m</b>
              </div>
              <div>
                <span className="text-muted">In the bank:</span>{" "}
                <b>£{fmtPrice(1000 - launch.cost)}m</b>
              </div>
              <div>
                <span className="text-muted">Projected (GW{upcomingEvent}, incl. captain):</span>{" "}
                <b className="text-accent">{launch.xi.totalXp.toFixed(1)} xp</b>
              </div>
            </div>
            <Pitch
              starters={launch.xi.starters.map((s) => ({
                element: s.element,
                xp: s.xp,
                isCaptain: s.isCaptain,
                isVice: s.isVice,
              }))}
              bench={launch.xi.bench.map((s) => ({ element: s.element, xp: s.xp }))}
              teams={teams}
              fixtures={data.fixtures}
              nextEvent={upcomingEvent}
              formation={launch.xi.formation}
              onSelect={onSelect}
            />
            <div className="card p-4">
              <div className="text-sm font-semibold">Type this into fantasy.premierleague.com:</div>
              <div className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
                {launch.squad
                  .slice()
                  .sort((a, b) => a.element_type - b.element_type || b.now_cost - a.now_cost)
                  .map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      onClick={onSelect ? () => onSelect(e) : undefined}
                      className="flex items-center justify-between rounded-lg border border-transparent bg-panel-2 px-3 py-2 text-left hover:border-accent active:border-accent"
                    >
                      <span className="truncate">
                        <span className="mr-1.5 text-xs text-muted">
                          {["GK", "DEF", "MID", "FWD"][e.element_type - 1]}
                        </span>
                        {e.web_name}{" "}
                        <span className="text-xs text-muted">
                          {teams.get(e.team)?.short_name}
                        </span>
                      </span>
                      <span className="ml-2 shrink-0 font-mono">£{fmtPrice(e.now_cost)}m</span>
                    </button>
                  ))}
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  if (!squad || squad.nextEvent == null) {
    return (
      <div className="card p-6 text-muted">
        Optimization needs an active squad and an upcoming gameweek. The season may be over,
        or this team hasn&apos;t played a gameweek yet.
      </div>
    );
  }

  const chipsLeft = remainingChips(
    data.history.chips.map((c) => ({ name: c.name, event: c.event })),
    data.bootstrap.chips ?? null,
    squad.nextEvent
  );

  function run() {
    setRunning(true);
    // Let the spinner paint before the (CPU-bound) search starts.
    setTimeout(() => {
      try {
        const res = optimize({
          bootstrap: data.bootstrap,
          fixtures: data.fixtures,
          owned: squad!.players,
          bank: squad!.bank,
          freeTransfers: squad!.freeTransfers,
          nextEvent: squad!.nextEvent!,
          horizon,
        });
        setResult(res);
      } finally {
        setRunning(false);
      }
    }, 30);
  }

  return (
    <div className="space-y-6">
      {infoOpen && (
        <Sheet onClose={() => setInfoOpen(null)} labelledBy="opt-info-title" maxWidth="max-w-md">
          <div>
            <div className="flex items-center justify-between">
              <h2 id="opt-info-title" className="text-lg font-bold">{infoOpen.title}</h2>
              <SheetClose onClose={() => setInfoOpen(null)} />
            </div>
            <div className="mt-3 space-y-2 text-sm text-muted">
              {infoOpen.body.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          </div>
        </Sheet>
      )}
      <div className="card flex flex-wrap items-center gap-4 p-4">
        <div className="w-full">
          <DeadlineNote
            gw={squad.nextEvent}
            deadline={
              data.bootstrap.events.find((e) => e.id === squad.nextEvent)?.deadline_time ?? null
            }
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-muted">Horizon:</label>
          <select
            value={horizon}
            onChange={(e) => setHorizon(parseInt(e.target.value))}
            className="rounded-lg bg-panel-2 border border-border-c px-3 py-2 text-sm"
          >
            {[1, 2, 3, 5, 8].map((h) => (
              <option key={h} value={h}>
                {h} gameweek{h > 1 ? "s" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <button
            type="button"
            className="-m-1.5 p-1.5"
            onClick={() =>
              setInfoOpen({
                title: `${squad.freeTransfers} free transfer${squad.freeTransfers === 1 ? "" : "s"}`,
                body: [
                  `You currently have ${squad.freeTransfers} free transfer${squad.freeTransfers === 1 ? "" : "s"} for GW${squad.nextEvent}.`,
                  "You gain +1 free transfer every gameweek and can bank up to 5. Each transfer beyond your free ones costs −4 points.",
                  "The optimizer already accounts for this: plans marked with a hit only appear when the projected gain outweighs the −4.",
                ],
              })
            }
          >
            <Badge tone="green">
              {squad.freeTransfers} free transfer{squad.freeTransfers === 1 ? "" : "s"}
            </Badge>
          </button>
          <button
            type="button"
            className="-m-1.5 p-1.5"
            onClick={() =>
              setInfoOpen({
                title: `Bank £${fmtPrice(squad.bank)}m`,
                body: [
                  `Money left over after your squad — available to spend on transfers in addition to what you raise from sales.`,
                  "Selling prices follow the official rule: you keep your purchase price plus 50% of any price rise, rounded down to £0.1m. Price falls are absorbed in full.",
                ],
              })
            }
          >
            <Badge>Bank £{fmtPrice(squad.bank)}m</Badge>
          </button>
          {chipsLeft.map((c, i) => {
            const windows = (data.bootstrap.chips ?? []).filter((w) => w.name === c.name);
            const win = windows.find(
              (w) => squad.nextEvent! >= w.start_event && squad.nextEvent! <= w.stop_event
            );
            const desc: Record<string, string> = {
              wildcard:
                "Unlimited free transfers for one gameweek — rebuild the whole squad. Changes are permanent.",
              freehit:
                "Unlimited transfers for one gameweek only — your squad reverts afterwards. Great for blank/double gameweeks.",
              bboost: "Your four bench players' points count this gameweek.",
              "3xc": "Your captain scores triple instead of double this gameweek.",
            };
            const advice = result?.chipAdvice.find((a) => a.chip === c.name);
            return (
              <button
                key={i}
                type="button"
                className="-m-1.5 p-1.5"
                onClick={() =>
                  setInfoOpen({
                    title: `${c.label} — available`,
                    body: [
                      desc[c.name] ?? "",
                      win ? `Usable window: GW${win.start_event}–GW${win.stop_event}. Only one chip can be played per gameweek, and a played chip cannot be cancelled.` : "",
                      advice
                        ? `Projected gain if played now: +${advice.projectedGain.toFixed(1)} xp. ${advice.detail}`
                        : "Run the optimizer to see the projected gain of playing it this gameweek.",
                      "This list only shows chips you still have — used chips disappear from here (see the Chips left card up top).",
                    ].filter(Boolean),
                  })
                }
              >
                <Badge tone="purple">{c.label}</Badge>
              </button>
            );
          })}
        </div>
        <button
          onClick={run}
          disabled={running}
          className="btn-primary ml-auto rounded-lg px-5 py-2.5"
        >
          {running ? "Crunching…" : result ? "Re-run" : "Optimize team 🚀"}
        </button>
      </div>

      {!result && !running && (
        <div className="card p-6 text-sm text-muted">
          Hit “Optimize team” to compute the best XI, transfer plans, captaincy and chip
          advice for GW{squad.nextEvent}, based on your squad from GW{squad.currentEvent}.
        </div>
      )}

      {running && (
        <div className="card flex items-center gap-3 p-6 text-sm text-muted">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          Simulating thousands of squad combinations…
        </div>
      )}

      {result && (
        <>
          {/* Transfer plans */}
          <div>
            <SectionTitle>🔄 Transfer plans (next {horizon} GWs)</SectionTitle>
            <div className="mt-3 grid gap-3">
              <PlanRow
                title="Keep the team"
                sub={`0 transfers · best XI projects ${result.keepXi.totalXp.toFixed(1)} xp in GW${squad.nextEvent}`}
                net={result.keepHorizonXp}
                gain={0}
                best={!result.plans.some((p) => p.gainVsKeep > 0.05)}
              />
              {result.plans.map((plan) => (
                <div
                  key={plan.transfers.length}
                  className={`card p-4 ${
                    plan.gainVsKeep > 0.05 &&
                    plan.netXp === Math.max(...result.plans.map((p) => p.netXp))
                      ? "border-accent/60"
                      : ""
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold">
                      {plan.transfers.length} transfer{plan.transfers.length > 1 ? "s" : ""}
                      {plan.hitCost > 0 && (
                        <span className="text-danger"> (−{plan.hitCost} hit)</span>
                      )}
                      {plan.gainVsKeep > 0.05 &&
                        plan.netXp === Math.max(...result.plans.map((p) => p.netXp)) && (
                          <span className="ml-2">
                            <Badge tone="green">Recommended</Badge>
                          </span>
                        )}
                    </div>
                    <div className="text-sm">
                      <span
                        className={plan.gainVsKeep > 0.05 ? "text-accent font-semibold" : "text-muted"}
                      >
                        {plan.gainVsKeep >= 0 ? "+" : ""}
                        {plan.gainVsKeep.toFixed(1)} xp vs keeping
                      </span>
                      <span className="text-muted"> · bank after: £{fmtPrice(plan.bankAfter)}m</span>
                    </div>
                  </div>
                  <div className="mt-3 space-y-2">
                    {plan.transfers.map((m, i) => (
                      <div key={i} className="space-y-1 rounded-lg bg-panel-2 px-3 py-2 text-sm">
                        <div className="flex items-baseline justify-between gap-2">
                          <button
                            onClick={onSelect ? () => onSelect(m.out) : undefined}
                            className="min-w-0 truncate text-left text-danger hover:underline"
                          >
                            Out: {m.out.web_name} ({teams.get(m.out.team)?.short_name}) £
                            {fmtPrice(m.outSell)}m
                          </button>
                          <span className="shrink-0 whitespace-nowrap font-mono text-xs text-muted">
                            {(result.xp.get(m.out.id)?.total ?? 0).toFixed(1)} xp
                          </span>
                        </div>
                        <div className="flex items-baseline justify-between gap-2">
                          <button
                            onClick={onSelect ? () => onSelect(m.in) : undefined}
                            className="min-w-0 truncate text-left text-accent hover:underline"
                          >
                            In: {m.in.web_name} ({teams.get(m.in.team)?.short_name}) £
                            {fmtPrice(m.inCost)}m
                          </button>
                          <span className="shrink-0 whitespace-nowrap font-mono text-xs text-muted">
                            {(result.xp.get(m.in.id)?.total ?? 0).toFixed(1)} xp
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                  {plan.gainVsKeep <= 0.05 && plan.hitCost > 0 && (
                    <div className="mt-2 text-xs text-warn">
                      ⚠️ The hit doesn&apos;t pay off — better to keep your team.
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Captain */}
          <div>
            <SectionTitle>©️ Captaincy (GW{squad.nextEvent})</SectionTitle>
            <div className="mt-3 card divide-y divide-border-c">
              {result.captainRanking.map((c, i) => (
                <button
                  key={c.element.id}
                  type="button"
                  className={`flex w-full items-center gap-3 px-4 py-3 text-left ${onSelect ? "cursor-pointer hover:bg-panel-2/60 active:bg-panel-2" : ""}`}
                  onClick={onSelect ? () => onSelect(c.element) : undefined}
                >
                  <span className="w-6 text-center font-bold text-muted">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{c.element.web_name}</div>
                    <div className="text-xs text-muted">
                      {teams.get(c.element.team)?.short_name} · {c.element.selected_by_percent}%
                      owned
                    </div>
                  </div>
                  <div className="whitespace-nowrap font-mono text-accent">
                    {c.xp.toFixed(1)} xp
                  </div>
                  {i === 0 && <Badge tone="green">Captain</Badge>}
                  {i === 1 && <Badge>Vice</Badge>}
                </button>
              ))}
            </div>
          </div>

          {/* Chips */}
          <div>
            <SectionTitle>🃏 Chip advisor</SectionTitle>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {result.chipAdvice.map((a) => {
                const available = chipsLeft.some((c) => c.name === a.chip);
                return (
                  <div key={a.chip} className={`card p-4 ${available ? "" : "opacity-50"}`}>
                    <div className="flex items-center justify-between">
                      <div className="font-semibold">{CHIP_LABELS[a.chip] ?? a.label}</div>
                      {available ? (
                        <Badge tone="purple">Available</Badge>
                      ) : (
                        <Badge>Used / outside window</Badge>
                      )}
                    </div>
                    <div className="mt-1 text-2xl font-bold text-accent">
                      +{a.projectedGain.toFixed(1)} <span className="text-sm">xp</span>
                    </div>
                    <div className="mt-1 text-xs text-muted">{a.detail}</div>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-muted">
              Only one chip per gameweek. Watch for double/blank gameweeks — Bench Boost and
              Triple Captain usually pay most in doubles, Free Hit in blanks.
            </p>
          </div>

          {/* XI views */}
          <div>
            <SectionTitle>📋 Line-up</SectionTitle>
            <div className="mt-2 grid w-full grid-cols-3 gap-1 rounded-lg bg-panel-2 p-1 text-xs sm:flex sm:w-fit sm:text-sm">
              {(
                [
                  ["plans", "Best plan"],
                  ["xi", "No transfers"],
                  ["dream", "Dream £100m"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setView(key)}
                  className={`whitespace-nowrap rounded-md px-2 py-1.5 sm:px-3 ${view === key ? "btn-primary" : "text-muted"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="mt-3">
              {(() => {
                const bestPlan = [...result.plans].sort((a, b) => b.netXp - a.netXp)[0];
                const xi =
                  view === "dream"
                    ? result.dreamTeam
                    : view === "plans" && bestPlan && bestPlan.gainVsKeep > 0.05
                      ? bestPlan.nextXi
                      : result.keepXi;
                return (
                  <Pitch
                    starters={xi.starters.map((s) => ({
                      element: s.element,
                      xp: s.xp,
                      isCaptain: s.isCaptain,
                      isVice: s.isVice,
                    }))}
                    bench={xi.bench.map((s) => ({ element: s.element, xp: s.xp }))}
                    teams={teams}
                    fixtures={data.fixtures}
                    nextEvent={squad.nextEvent}
                    formation={xi.formation}
                    onSelect={onSelect}
                  />
                );
              })()}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function PlanRow({
  title,
  sub,
  net,
  gain,
  best,
}: {
  title: string;
  sub: string;
  net: number;
  gain: number;
  best: boolean;
}) {
  return (
    <div className={`card flex items-center justify-between p-4 ${best ? "border-accent/60" : ""}`}>
      <div>
        <div className="font-semibold">
          {title} {best && <Badge tone="green">Recommended</Badge>}
        </div>
        <div className="text-sm text-muted">{sub}</div>
      </div>
      <div className="text-right">
        <div className="whitespace-nowrap font-mono font-bold">{net.toFixed(1)} xp</div>
        <div className="text-xs text-muted">{gain >= 0 ? "baseline" : ""}</div>
      </div>
    </div>
  );
}
