// Original golden flame-silhouette lion for FPL Optimizer.
// Hand-drawn vector artwork made for this app (own composition — not a
// trademarked or stock mark). Negative space uses the badge background color.

const BADGE_BG = "#241028";

function LionArt() {
  return (
    <g>
      <path d="M56,6 L50,16 L40,10 L40,20 L28,14 L32,24 L18,20 L26,30 L12,28 L22,38 L8,40 L20,46 L6,52 L20,56 L10,66 L24,64 L16,78 L30,72 L26,88 L38,78 L38,94 L48,80 L52,94 L58,82 L60,72 L56,40 L60,20 Z" fill="#d9a441"/>
      <path d="M40,22 L24,30 L40,32 Z" fill="#241028"/>
      <path d="M34,38 L14,44 L34,48 Z" fill="#241028"/>
      <path d="M34,54 L16,62 L36,62 Z" fill="#241028"/>
      <path d="M42,66 L30,80 L46,72 Z" fill="#241028"/>
      <path d="M50,14 L44,24 L52,24 Z" fill="#241028"/>
      <path d="M42,44 L32,52 L44,52 Z" fill="#241028"/>
      <path d="M54.0,16 L64.0,22 L72.0,27 L80.0,31 L94.0,34 L92.0,43 L88.0,46 L76.0,49 L70.0,54 L66.0,66 L62.0,74 L56.0,72 L52.0,60 L51.0,30 Z" fill="#d9a441"/>
      <path d="M93,45 L74,50 L64,57 L58,70 L70,67 L88,55 Z" fill="#241028"/>
      <path d="M87.0,45 L84.0,56 L80.0,47 Z" fill="#f5ead0"/>
      <path d="M78.0,48 L76.0,54 L73.0,50 Z" fill="#f5ead0"/>
      <path d="M92,68 L78,68 L66,70 L60,77 L68,83 L82,77 L94,72 Z" fill="#d9a441"/>
      <path d="M80,77 L74,84 L70,78 Z" fill="#d9a441"/>
      <path d="M88,66 L85,58 L81,68 Z" fill="#f5ead0"/>
      <path d="M96.0,31.5 L84.0,29.5 L87.0,40 L94.0,38 Z" fill="#d9a441"/>
      <path d="M74.0,25 L60.0,20 L59.0,26 L71.0,30.5 Z" fill="#d9a441"/>
      <path d="M69.0,29 L62.0,26.5 L61.0,30.5 L67.0,32.5 Z" fill="#241028"/>
      <path d="M58.0,20 L50.0,13 L48.0,24 Z" fill="#d9a441"/>
      <path d="M83.0,31 L75.0,29 M82.0,34.5 L74.0,32.5" stroke="#241028" strokeWidth="1.5" strokeLinecap="round" fill="none"/>
    </g>
  );
}

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
        <path id="lion-arc" d="M 15,50 A 35,35 0 0 1 85,50" fill="none" />
      </defs>

      <circle cx="50" cy="50" r="48" fill={BADGE_BG} />
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

      <g transform="translate(50,57) scale(0.6) translate(-50,-50)">
        <LionArt />
      </g>
    </svg>
  );
}
