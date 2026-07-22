import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FPL Optimizer — beste lag hver runde",
  description:
    "Legg inn FPL-ID-en din og få optimalt lag, transferforslag, kapteinsvalg og chip-råd — basert på alle offisielle FPL-regler.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="nb" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {children}
        <footer className="mt-auto py-6 text-center text-xs text-muted">
          Uoffisiell app — ikke tilknyttet Premier League eller FPL.
        </footer>
      </body>
    </html>
  );
}
