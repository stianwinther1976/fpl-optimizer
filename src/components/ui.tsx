"use client";

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-panel-2 ${className}`} />;
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
      {message}
    </div>
  );
}

export interface StatDelta {
  /** Signed, human-formatted change, e.g. "+187" or "−0.4" */
  text: string;
  /** The period compared against, e.g. "vs GW6" */
  period: string;
  /** true = favorable (green), false = unfavorable (red), null = neutral */
  good: boolean | null;
  /** Direction of the arrow; defaults to the sign implied by `good` */
  direction?: "up" | "down";
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const w = 72;
  const h = 22;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const coords = points.map(
    (p, i) => [i * step, h - 2 - ((p - min) / span) * (h - 4)] as const
  );
  const path = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lx, ly] = coords[coords.length - 1];
  return (
    <svg width={w} height={h} className="mt-1" aria-hidden="true">
      <path d={path} fill="none" stroke="var(--muted)" strokeWidth="1.5" opacity="0.7" />
      <circle cx={lx} cy={ly} r="2.5" fill="var(--accent)" />
    </svg>
  );
}

export function Stat({
  label,
  value,
  sub,
  accent,
  delta,
  trend,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  delta?: StatDelta | null;
  trend?: number[];
}) {
  const arrow =
    delta && delta.good !== null
      ? (delta.direction ?? (delta.good === false ? "down" : "up")) === "up"
        ? "▲"
        : "▼"
      : null;
  const deltaColor =
    delta?.good === true ? "text-accent" : delta?.good === false ? "text-danger" : "text-muted";
  return (
    <div className="card px-2.5 py-2 sm:px-4 sm:py-3">
      <div className="truncate text-[11px] tracking-wide text-muted sm:text-xs">{label}</div>
      <div className={`mt-0.5 text-base font-semibold sm:text-xl ${accent ? "text-accent" : ""}`}>
        {value}
      </div>
      {delta && (
        <div className={`mt-0.5 text-[11px] font-medium sm:text-xs ${deltaColor}`}>
          {arrow} {delta.text} <span className="font-normal text-muted">{delta.period}</span>
        </div>
      )}
      {trend && (
        <div className="hidden sm:block">
          <Sparkline points={trend} />
        </div>
      )}
      {sub && <div className="mt-0.5 truncate text-[11px] text-muted sm:text-xs" title={sub}>{sub}</div>}
    </div>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-lg font-bold tracking-tight">{children}</h2>;
}

export function Badge({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: "default" | "green" | "purple" | "red" | "yellow";
}) {
  const tones: Record<string, string> = {
    default: "bg-panel-2 text-muted border-border-c",
    green: "bg-accent/15 text-accent border-accent/40",
    purple: "bg-accent-2/15 text-accent-2 border-accent-2/40",
    red: "bg-danger/15 text-danger border-danger/40",
    yellow: "bg-warn/15 text-warn border-warn/40",
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}
