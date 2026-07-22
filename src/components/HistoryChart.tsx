"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  ReferenceDot,
} from "recharts";
import type { TeamData } from "@/lib/fpl";
import { CHIP_LABELS } from "@/lib/rules";
import { SectionTitle } from "./ui";

function PastSeasons({ data }: { data: TeamData }) {
  const past = data.history.past;
  if (past.length === 0) return null;
  const last3 = past.slice(-3);
  const avgRank = Math.round(last3.reduce((s, p) => s + p.rank, 0) / last3.length);
  const bestRank = Math.min(...past.map((p) => p.rank));
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle>Past seasons</SectionTitle>
        <div className="text-sm text-muted">
          {past.length} season{past.length > 1 ? "s" : ""} · last {last3.length} avg rank{" "}
          <span className="font-semibold text-foreground">{avgRank.toLocaleString("en-GB")}</span>{" "}
          · best <span className="font-semibold text-accent">{bestRank.toLocaleString("en-GB")}</span>
        </div>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-100 text-sm">
          <thead className="border-b border-border-c text-xs uppercase text-muted">
            <tr>
              <th className="px-2 py-1.5 text-left">Season</th>
              <th className="px-2 py-1.5 text-right">Points</th>
              <th className="px-2 py-1.5 text-right">Overall rank</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-c/60">
            {[...past].reverse().map((p) => (
              <tr key={p.season_name} className={p.rank === bestRank ? "text-accent" : ""}>
                <td className="px-2 py-1.5 font-medium">{p.season_name}</td>
                <td className="px-2 py-1.5 text-right font-mono">{p.total_points}</td>
                <td className="px-2 py-1.5 text-right font-mono">
                  {p.rank.toLocaleString("en-GB")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function HistoryChart({ data }: { data: TeamData }) {
  const rows = data.history.current.map((r) => ({
    gw: r.event,
    points: r.points,
    average: data.bootstrap.events.find((e) => e.id === r.event)?.average_entry_score ?? null,
    total: r.total_points,
    rank: r.overall_rank,
  }));

  const chips = data.history.chips;

  if (rows.length === 0) {
    return (
      <div className="space-y-6">
        <div className="card p-6 text-muted">No history yet this season.</div>
        <PastSeasons data={data} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PastSeasons data={data} />
      <div className="card p-4">
        <SectionTitle>Points per gameweek</SectionTitle>
        <div className="mt-4 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis dataKey="gw" stroke="var(--muted)" fontSize={12} />
              <YAxis stroke="var(--muted)" fontSize={12} width={32} />
              <Tooltip
                contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--foreground)" }}
                labelFormatter={(gw) => `GW${gw}`}
              />
              <Line type="monotone" dataKey="points" stroke="var(--accent)" strokeWidth={2} dot={false} name="You" />
              <Line type="monotone" dataKey="average" stroke="var(--muted)" strokeWidth={1.5} strokeDasharray="4 4" dot={false} name="Average" />
              {chips.map((c) => {
                const row = rows.find((r) => r.gw === c.event);
                return row ? (
                  <ReferenceDot
                    key={`${c.name}-${c.event}`}
                    x={c.event}
                    y={row.points}
                    r={5}
                    fill="var(--accent-2)"
                    stroke="none"
                    label={{
                      value: CHIP_LABELS[c.name] ?? c.name,
                      position: "top",
                      fill: "var(--accent-2)",
                      fontSize: 10,
                    }}
                  />
                ) : null;
              })}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card p-4">
        <SectionTitle>Overall rank</SectionTitle>
        <div className="mt-4 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis dataKey="gw" stroke="var(--muted)" fontSize={12} />
              <YAxis
                stroke="var(--muted)"
                fontSize={12}
                width={60}
                reversed
                tickFormatter={(v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))}
              />
              <Tooltip
                contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--foreground)" }}
                labelFormatter={(gw) => `GW${gw}`}
                formatter={(v) => [Number(v).toLocaleString("en-GB"), "Rank"]}
              />
              <Line type="monotone" dataKey="rank" stroke="var(--accent-2)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
