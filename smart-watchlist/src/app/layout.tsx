import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Smart Market Watchlist",
  description: "What deserves your attention right now, and what changed since you last looked.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-zinc-950 text-zinc-100">{children}</body>
    </html>
  );
}
