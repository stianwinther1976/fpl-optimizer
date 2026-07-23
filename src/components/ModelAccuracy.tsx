"use client";

// The model's own report card: how predictions hit each gameweek, and the
// corrections it has taught itself from those misses.

import { useEffect, useState } from "react";
import {
  loadCalibration,
  calibrationMultiplier,
  type CalibrationState,
} from "@/lib/calibration";
import { POSITION_NAMES } from "@/lib/rules";

export default function ModelAccuracy({ demo }: { demo: boolean }) {
  const [state, setState] = useState<CalibrationState | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading persisted, client-only data on mount
    setState(loadCalibration(demo));
  }, [demo]);
  if (!state) return null;

  const { factors, log } = state;
  const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}%`;
  const first = log[0];
  const last = log[log.length - 1];
  const improving = log.length >= 2 && last.mae < first.mae - 1e-9;

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-bold">🎯 Model accuracy — it grades itself</div>
        {demo && (
          <span className="rounded-full border border-warn/50 bg-warn/10 px-2 py-0.5 text-xs font-semibold text-warn">
            demo data
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-muted">
        Before every deadline the app saves what it predicted; when the gameweek finishes it
        compares against the real points and adjusts its own weights. Systematic misses shrink
        automatically over time.
      </p>

      {log.length === 0 ? (
        <p className="mt-3 rounded-lg bg-panel-2 px-3 py-2.5 text-sm text-muted">
          No graded gameweeks yet — tracking starts automatically: open the app before a
          deadline (the prediction is saved), then again after the gameweek (it gets graded).
        </p>
      ) : (
        <>
          <table className="mt-3 w-full text-sm">
            <thead className="border-b border-border-c text-xs uppercase text-muted">
              <tr>
                <th className="px-1.5 py-1.5 text-left">GW</th>
                <th className="px-1.5 py-1.5 text-right" title="Players graded">
                  Players
                </th>
                <th
                  className="px-1.5 py-1.5 text-right"
                  title="Mean absolute error — average miss per player, in points"
                >
                  Avg miss
                </th>
                <th
                  className="px-1.5 py-1.5 text-right"
                  title="Positive = the model predicted too high overall"
                >
                  Bias
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-c/60">
              {[...log].reverse().map((r) => (
                <tr key={r.gw}>
                  <td className="px-1.5 py-1.5 font-mono text-xs">GW{r.gw}</td>
                  <td className="px-1.5 py-1.5 text-right font-mono text-muted">{r.n}</td>
                  <td className="px-1.5 py-1.5 text-right font-mono">{r.mae.toFixed(2)} pts</td>
                  <td
                    className={`px-1.5 py-1.5 text-right font-mono ${
                      Math.abs(r.bias) <= 0.03
                        ? "text-accent"
                        : Math.abs(r.bias) <= 0.08
                          ? "text-warn"
                          : "text-danger"
                    }`}
                  >
                    {fmtPct(r.bias)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {improving && (
            <div className="mt-2 text-xs text-accent">
              ▼ Average miss down from {first.mae.toFixed(2)} to {last.mae.toFixed(2)} pts per
              player since GW{first.gw} — the corrections are working.
            </div>
          )}
        </>
      )}

      <div className="mt-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">
          Current self-corrections
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {[1, 2, 3, 4].map((pos) => {
            const m = calibrationMultiplier(factors, pos);
            const off = Math.abs(m - 1) >= 0.005;
            return (
              <span
                key={pos}
                className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                  off ? "border-accent/40 bg-accent/10 text-accent" : "border-border-c bg-panel-2 text-muted"
                }`}
                title={`All ${POSITION_NAMES[pos as 1 | 2 | 3 | 4]} projections are multiplied by ${m.toFixed(2)}`}
              >
                {POSITION_NAMES[pos as 1 | 2 | 3 | 4]} ×{m.toFixed(2)}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
