// Original golden roaring-lion badge for FPL Optimizer.
// Drawn from scratch for this app — inspired by classic lion emblems but
// deliberately NOT the trademarked MGM or Premier League marks.
export default function Lion({
  className = "h-24 w-24",
  showText = true,
}: {
  className?: string;
  showText?: boolean;
}) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="lion-gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e8c95c" />
          <stop offset="1" stopColor="#b8860b" />
        </linearGradient>
        <linearGradient id="lion-gold-deep" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c9942a" />
          <stop offset="1" stopColor="#8f6410" />
        </linearGradient>
        <path id="lion-arc" d="M 15,50 A 35,35 0 0 1 85,50" fill="none" />
      </defs>

      {/* Badge */}
      <circle cx="50" cy="50" r="48" fill="#241028" />
      <circle cx="50" cy="50" r="47" fill="none" stroke="url(#lion-gold)" strokeWidth="2.4" />
      <circle cx="50" cy="50" r="42.5" fill="none" stroke="url(#lion-gold)" strokeWidth="0.8" opacity="0.7" />

      {showText && (
        <text
          fill="#e2bd52"
          fontSize="8.2"
          fontWeight="700"
          letterSpacing="1.6"
          fontFamily="ui-sans-serif, system-ui, sans-serif"
        >
          <textPath href="#lion-arc" startOffset="50%" textAnchor="middle">
            FPL OPTIMIZER
          </textPath>
        </text>
      )}

      {/* Mane — two layered spike rings */}
      <path
        d="M50.0,22.5 L54.1,29.4 L60.5,24.6 L61.7,32.5 L69.4,30.6 L67.5,38.3 L75.4,39.5 L70.6,45.9 L77.5,50.0 L70.6,54.1 L75.4,60.5 L67.5,61.7 L69.4,69.4 L61.7,67.5 L60.5,75.4 L54.1,70.6 L50.0,77.5 L45.9,70.6 L39.5,75.4 L38.3,67.5 L30.6,69.4 L32.5,61.7 L24.6,60.5 L29.4,54.1 L22.5,50.0 L29.4,45.9 L24.6,39.5 L32.5,38.3 L30.6,30.6 L38.3,32.5 L39.5,24.6 L45.9,29.4 Z"
        fill="url(#lion-gold-deep)"
      />
      <path
        d="M54.7,26.5 L57.1,32.9 L63.3,30.0 L63.1,36.9 L70.0,36.7 L67.1,42.9 L73.5,45.3 L68.5,50.0 L73.5,54.7 L67.1,57.1 L70.0,63.3 L63.1,63.1 L63.3,70.0 L57.1,67.1 L54.7,73.5 L50.0,68.5 L45.3,73.5 L42.9,67.1 L36.7,70.0 L36.9,63.1 L30.0,63.3 L32.9,57.1 L26.5,54.7 L31.5,50.0 L26.5,45.3 L32.9,42.9 L30.0,36.7 L36.9,36.9 L36.7,30.0 L42.9,32.9 L45.3,26.5 L50.0,31.5 Z"
        fill="url(#lion-gold)"
      />

      {/* Ears */}
      <circle cx="41" cy="39" r="4" fill="#dcae4f" />
      <circle cx="59" cy="39" r="4" fill="#dcae4f" />
      <circle cx="41" cy="39" r="1.8" fill="#241028" />
      <circle cx="59" cy="39" r="1.8" fill="#241028" />

      {/* Head */}
      <circle cx="50" cy="51" r="14" fill="#dcae4f" />

      {/* Brow + eyes (fierce) */}
      <path d="M42 45.5l5.5 2M58 45.5l-5.5 2" stroke="#241028" strokeWidth="1.6" strokeLinecap="round" />
      <ellipse cx="44.8" cy="49.2" rx="2" ry="1.5" fill="#241028" />
      <ellipse cx="55.2" cy="49.2" rx="2" ry="1.5" fill="#241028" />

      {/* Nose */}
      <path d="M50 55.5l-3-2.3h6z" fill="#241028" />

      {/* Roaring mouth with fangs */}
      <path d="M44.5 58c0 4 2.2 6.5 5.5 6.5s5.5-2.5 5.5-6.5c-1.6-.9-3.6-1.4-5.5-1.4s-3.9.5-5.5 1.4z" fill="#241028" />
      <path d="M46.3 57.2l1.5-.3.2 2.3z" fill="#f5ead0" />
      <path d="M53.7 57.2l-1.5-.3-.2 2.3z" fill="#f5ead0" />
    </svg>
  );
}
