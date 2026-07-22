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

export function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className="card px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-xl font-bold ${accent ? "text-accent" : ""}`}>{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
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
