import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FPL Optimizer — your best team every gameweek",
  description:
    "Enter your FPL ID and get the optimal team, transfer suggestions, captain picks and chip advice — built on every official FPL rule.",
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
        {children}
        <footer className="mt-auto space-y-1.5 py-6 text-center text-xs text-muted">
          <div>
            <a
              href={process.env.NEXT_PUBLIC_SUPPORT_URL ?? "https://github.com/stianwinther1976/fpl-optimizer"}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-border-c bg-panel px-3 py-1 font-medium text-foreground hover:border-accent"
            >
              <span className="text-danger">♥</span> Support this project
            </a>
          </div>
          <div>Unofficial app — not affiliated with the Premier League or FPL.</div>
        </footer>
      </body>
    </html>
  );
}
