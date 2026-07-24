import type { Metadata, Viewport } from "next";
import "./globals.css";
import UpdateToast from "@/components/UpdateToast";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "FPL Optimizer — smarter FPL transfers, captain picks & chip timing",
    template: "%s · FPL Optimizer",
  },
  description:
    "Free Fantasy Premier League optimizer: enter your FPL ID and get data-driven transfer suggestions, captain picks, chip timing, live points with auto-subs and a 6-gameweek transfer planner — built on every official FPL rule, with a prediction model that grades itself against real results.",
  keywords: [
    "FPL",
    "Fantasy Premier League",
    "FPL optimizer",
    "FPL transfer planner",
    "FPL captain picks",
    "FPL chip strategy",
    "FPL tools",
    "FPL live points",
    "fantasy football optimizer",
  ],
  manifest: "/manifest.webmanifest",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "FPL Optimizer",
    title: "FPL Optimizer — smarter FPL transfers, captain picks & chip timing",
    description:
      "Enter your FPL ID and get data-driven transfer plans, captaincy and chip advice — every official FPL rule built in, predictions that grade themselves.",
    images: [{ url: "/icon-512.png", width: 512, height: 512, alt: "FPL Optimizer lion logo" }],
  },
  twitter: {
    card: "summary",
    title: "FPL Optimizer — smarter FPL decisions every gameweek",
    description:
      "Free FPL tool: data-driven transfers, captain picks, chip timing, live points with auto-subs and a 6-GW planner.",
    images: ["/icon-512.png"],
  },
};

export const viewport: Viewport = {
  // Edge-to-edge on notched phones; sheets/toasts pad with safe-area insets.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0d1117" },
    { media: "(prefers-color-scheme: light)", color: "#f2f2f7" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script
          // Apply the saved theme before first paint to avoid a flash.
          dangerouslySetInnerHTML={{
            __html:
              "try{if(localStorage.getItem('theme')==='light')document.documentElement.classList.add('light')}catch(e){}",
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        {/* Structured data so Google understands this is a free web app */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "WebApplication",
              name: "FPL Optimizer",
              url: SITE_URL,
              applicationCategory: "SportsApplication",
              operatingSystem: "Any",
              offers: { "@type": "Offer", price: "0", priceCurrency: "GBP" },
              description:
                "Free Fantasy Premier League optimizer: data-driven transfers, captain picks, chip advice, live points with auto-subs and a multi-gameweek transfer planner.",
            }),
          }}
        />
        {children}
        <UpdateToast />
        <footer className="mt-auto py-6 text-center text-xs text-muted">
          {process.env.NEXT_PUBLIC_SUPPORT_URL && (
            <div className="mb-1.5">
              <a
                href={process.env.NEXT_PUBLIC_SUPPORT_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-full border border-border-c bg-panel px-3 py-1 font-medium text-foreground hover:border-accent"
              >
                <span className="text-danger">♥</span> Support this project
              </a>
            </div>
          )}
          Unofficial app — not affiliated with the Premier League or FPL.
        </footer>
      </body>
    </html>
  );
}
