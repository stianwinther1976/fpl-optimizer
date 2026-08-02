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
import { netGwPoints } from "@/lib/display";
import { CHIP_LABELS } from "@/lib/rules";
import { SectionTitle } from "./ui";
import PastSeasons from "./PastSeasons";

export default function HistoryChart({ data, entryId }: { data: TeamData; entryId: number }) {
  const rows = data.history.current.map((r) => ({
    gw: r.event,
    // Net of hits. `average` on the other line is FPL's own average score for
    // the week, and plotting a gross score against it flattered every week the
    // manager took a hit — by exactly the size of the hit, on the one chart
    // whose whole job is "did I beat the average".
    points: netGwPoints(r),
    average: data.bootstrap.events.find((e) => e.id === r.event)?.average_entry_score ?? null,
    total: r.total_points,
    rank: r.overall_rank,
  }));

  const chips = data.history.chips;

  if (rows.length === 0) {
    return (
      <div className="space-y-6">
        <div className="card p-6 text-muted">No history yet this season.</div>
        <PastSeasons data={data} entryId={entryId} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PastSeasons data={data} entryId={entryId} />
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
