import { NextResponse } from "next/server";
import { ctx, requireWatchlist } from "@/lib/shared";
import { recentQuotes, displaySource, readBaseline, LIVE_NS, demoNs } from "@/lib/db";

export async function GET(req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const sym = decodeURIComponent(symbol).toUpperCase();
  const { user } = await ctx();
  // Namespace follows an owned watchlist when given; otherwise live data.
  const wlId = new URL(req.url).searchParams.get("watchlistId");
  let ns = LIVE_NS;
  if (wlId) {
    const wl = requireWatchlist(user.id, wlId);
    if (!wl) return NextResponse.json({ error: "Watchlist not found" }, { status: 404 });
    ns = wl.is_demo ? demoNs(user.id) : LIVE_NS;
  }
  const rows = recentQuotes(ns, sym, 30, displaySource(ns, sym));
  return NextResponse.json({
    symbol: sym,
    namespace: ns,
    // Accepted observation samples — NOT daily session history.
    samples: rows.map((h) => ({ price: Number(h.price), asOf: h.as_of, volume: h.volume == null ? null : Number(h.volume), source: h.source })),
    baseline: readBaseline(ns, sym),
  });
}
