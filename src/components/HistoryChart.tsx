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
      <div className="card p-6 text-muted">
        No history yet this season.
        {data.history.past.length > 0 && (
          <div className="mt-4">
            <div className="mb-2 font-semibold text-foreground">Past seasons</div>
            <table className="w-full max-w-md text-sm">
              <tbody className="divide-y divide-border-c/60">
                {data.history.past.map((p) => (
                  <tr key={p.season_name}>
                    <td className="py-1.5">{p.season_name}</td>
                    <td className="py-1.5 text-right font-mono">{p.total_points} pts</td>
                    <td className="py-1.5 text-right font-mono text-muted">
                      {p.rank.toLocaleString("en-GB")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="card p-4">
        <SectionTitle>Points per gameweek</SectionTitle>
        <div className="mt-4 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows}>
              <CartesianGrid stroke="#2b3442" strokeDasharray="3 3" />
              <XAxis dataKey="gw" stroke="#8b98a9" fontSize={12} />
              <YAxis stroke="#8b98a9" fontSize={12} width={32} />
              <Tooltip
                contentStyle={{ background: "#161b22", border: "1px solid #2b3442", borderRadius: 8 }}
                labelFormatter={(gw) => `GW${gw}`}
              />
              <Line type="monotone" dataKey="points" stroke="#37e08d" strokeWidth={2} dot={false} name="You" />
              <Line type="monotone" dataKey="average" stroke="#8b98a9" strokeWidth={1.5} strokeDasharray="4 4" dot={false} name="Average" />
              {chips.map((c) => {
                const row = rows.find((r) => r.gw === c.event);
                return row ? (
                  <ReferenceDot
                    key={`${c.name}-${c.event}`}
                    x={c.event}
                    y={row.points}
                    r={5}
                    fill="#a78bfa"
                    stroke="none"
                    label={{
                      value: CHIP_LABELS[c.name] ?? c.name,
                      position: "top",
                      fill: "#a78bfa",
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
              <CartesianGrid stroke="#2b3442" strokeDasharray="3 3" />
              <XAxis dataKey="gw" stroke="#8b98a9" fontSize={12} />
              <YAxis
                stroke="#8b98a9"
                fontSize={12}
                width={60}
                reversed
                tickFormatter={(v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))}
              />
              <Tooltip
                contentStyle={{ background: "#161b22", border: "1px solid #2b3442", borderRadius: 8 }}
                labelFormatter={(gw) => `GW${gw}`}
                formatter={(v) => [Number(v).toLocaleString("en-GB"), "Rank"]}
              />
              <Line type="monotone" dataKey="rank" stroke="#a78bfa" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
