import { useId } from "react";

// FPL Optimizer badge: user-supplied AI-generated roaring lion photo
// in a classic gold ring with arc text (MGM-style emblem, own assets).

export default function Lion({
  className = "h-24 w-24",
  showText = true,
}: {
  className?: string;
  showText?: boolean;
}) {
  /*
   * SVG DEFS IDS ARE DOCUMENT-GLOBAL, and these were fixed strings. One Lion is
   * fine; two on a page share the first one's gradient, clip path and text
   * path, because `url(#lion-ring)` resolves against the whole document and
   * takes whichever came first. `useId` is React's own answer to exactly this
   * and is stable across server and client render, so it does not break
   * hydration the way a counter or a random would.
   */
  const uid = useId().replace(/:/g, "");
  const ring = `lion-ring-${uid}`;
  const clip = `lion-clip-${uid}`;
  const arc = `lion-arc-${uid}`;
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={ring} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#00ff87" />
          <stop offset="1" stopColor="#00a65a" />
        </linearGradient>
        <clipPath id={clip}>
          <circle cx="50" cy="50" r="38" />
        </clipPath>
        <path id={arc} d="M 9,50 A 41,41 0 0 1 91,50" fill="none" />
      </defs>

      {/* Badge base */}
      <circle cx="50" cy="50" r="48" fill="#241028" />
      <circle cx="50" cy="50" r="47" fill="none" stroke={`url(#${ring})`} strokeWidth="2.4" />

      {/* Arc text in the dark band around the photo */}
      {showText && (
        <text
          fill="#00ff87"
          fontSize="6"
          fontWeight="700"
          letterSpacing="0.9"
          fontFamily="ui-sans-serif, system-ui, sans-serif"
        >
          <textPath href={`#${arc}`} startOffset="50%" textAnchor="middle">
            FANTASY PREMIER LEAGUE
          </textPath>
        </text>
      )}

      {/* The lion */}
      <image
        href="/lion-hero.jpg"
        x="12"
        y="12"
        width="76"
        height="76"
        clipPath={`url(#${clip})`}
        preserveAspectRatio="xMidYMid slice"
      />
      <circle cx="50" cy="50" r="38.5" fill="none" stroke={`url(#${ring})`} strokeWidth="1.6" />
    </svg>
  );
}
