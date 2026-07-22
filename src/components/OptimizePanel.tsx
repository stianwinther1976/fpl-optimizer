"use client";

import { useMemo, useState } from "react";
import type { TeamData } from "@/lib/fpl";
import { optimize, type OptimizerResult } from "@/lib/optimizer";
import { fmtPrice, remainingChips, CHIP_LABELS } from "@/lib/rules";
import { Badge, SectionTitle } from "./ui";
import Pitch from "./Pitch";

export default function OptimizePanel({ data }: { data: TeamData }) {
  const [horizon, setHorizon] = useState(5);
  const [result, setResult] = useState<OptimizerResult | null>(null);
  const [running, setRunning] = useState(false);
  const [view, setView] = useState<"plans" | "xi" | "dream">("plans");

  const squad = data.squad;
  const teams = useMemo(
    () => new Map(data.bootstrap.teams.map((t) => [t.id, t])),
    [data.bootstrap]
  );

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
      <div className="card flex flex-wrap items-center gap-4 p-4">
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
        <div className="flex items-center gap-2 text-sm text-muted">
          <Badge tone="green">{squad.freeTransfers} free transfers</Badge>
          <Badge>Bank £{fmtPrice(squad.bank)}m</Badge>
          {chipsLeft.map((c, i) => (
            <Badge key={i} tone="purple">
              {c.label}
            </Badge>
          ))}
        </div>
        <button
          onClick={run}
          disabled={running}
          className="ml-auto rounded-lg bg-accent px-5 py-2.5 font-semibold text-black hover:opacity-90 disabled:opacity-50"
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
                <div key={plan.transfers.length} className="card p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-semibold">
                      {plan.transfers.length} transfer{plan.transfers.length > 1 ? "s" : ""}
                      {plan.hitCost > 0 && (
                        <span className="text-danger"> (−{plan.hitCost} hit)</span>
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
                      <div
                        key={i}
                        className="flex flex-wrap items-center gap-2 rounded-lg bg-panel-2 px-3 py-2 text-sm"
                      >
                        <span className="text-danger">
                          Out: {m.out.web_name} ({teams.get(m.out.team)?.short_name}) £
                          {fmtPrice(m.outSell)}m
                        </span>
                        <span className="text-muted">→</span>
                        <span className="text-accent">
                          In: {m.in.web_name} ({teams.get(m.in.team)?.short_name}) £
                          {fmtPrice(m.inCost)}m
                        </span>
                        <span className="ml-auto text-xs text-muted">
                          {(result.xp.get(m.out.id)?.total ?? 0).toFixed(1)} →{" "}
                          {(result.xp.get(m.in.id)?.total ?? 0).toFixed(1)} xp
                        </span>
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
                <div key={c.element.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="w-6 text-center font-bold text-muted">{i + 1}</span>
                  <div className="flex-1">
                    <div className="font-semibold">
                      {c.element.web_name}{" "}
                      <span className="text-xs text-muted">
                        {teams.get(c.element.team)?.short_name} ·{" "}
                        {c.element.selected_by_percent}% owned
                      </span>
                    </div>
                  </div>
                  <div className="font-mono text-accent">{c.xp.toFixed(1)} xp</div>
                  {i === 0 && <Badge tone="green">Captain</Badge>}
                  {i === 1 && <Badge>Vice</Badge>}
                </div>
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
            <div className="flex items-center gap-3">
              <SectionTitle>📋 Line-up</SectionTitle>
              <div className="flex gap-1 rounded-lg bg-panel-2 p-1 text-sm">
                {(
                  [
                    ["plans", "After best plan"],
                    ["xi", "No transfers"],
                    ["dream", "Dream team (£100m)"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setView(key)}
                    className={`rounded-md px-3 py-1.5 ${view === key ? "bg-accent text-black font-semibold" : "text-muted"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
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
        <div className="font-mono font-bold">{net.toFixed(1)} xp</div>
        <div className="text-xs text-muted">{gain >= 0 ? "baseline" : ""}</div>
      </div>
    </div>
  );
}
