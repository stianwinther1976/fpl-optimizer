// Original stylized lion mark in FPL brand colors (drawn for this app —
// deliberately NOT the trademarked Premier League lion).
export default function Lion({ className = "h-16 w-16" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      {/* Mane */}
      <path
        d="M32.0,3.0 L37.6,11.2 L46.5,6.9 L47.2,16.8 L57.1,17.5 L52.8,26.4 L61.0,32.0 L52.8,37.6 L57.1,46.5 L47.2,47.2 L46.5,57.1 L37.6,52.8 L32.0,61.0 L26.4,52.8 L17.5,57.1 L16.8,47.2 L6.9,46.5 L11.2,37.6 L3.0,32.0 L11.2,26.4 L6.9,17.5 L16.8,16.8 L17.5,6.9 L26.4,11.2 Z"
        fill="var(--accent-vivid, #00ff87)"
      />
      {/* Head */}
      <circle cx="32" cy="32" r="16.5" fill="#37003c" />
      {/* Ears */}
      <circle cx="21.5" cy="21.5" r="4.5" fill="#37003c" />
      <circle cx="42.5" cy="21.5" r="4.5" fill="#37003c" />
      {/* Eyes */}
      <circle cx="26" cy="29.5" r="2.3" fill="var(--accent-vivid, #00ff87)" />
      <circle cx="38" cy="29.5" r="2.3" fill="var(--accent-vivid, #00ff87)" />
      {/* Nose + muzzle */}
      <path d="M32 35.5l-3.4-2.6h6.8z" fill="var(--accent-vivid, #00ff87)" />
      <path
        d="M32 36v3.2M32 39.2c0 2-1.8 3.4-4 3.4M32 39.2c0 2 1.8 3.4 4 3.4"
        stroke="var(--accent-vivid, #00ff87)"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
