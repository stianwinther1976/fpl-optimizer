import type { Metadata, Viewport } from "next";
import "./globals.css";
import UpdateToast from "@/components/UpdateToast";

export const metadata: Metadata = {
  title: "FPL Optimizer — your best team every gameweek",
  description:
    "Enter your FPL ID and get the optimal team, transfer suggestions, captain picks and chip advice — built on every official FPL rule.",
  manifest: "/manifest.webmanifest",
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
