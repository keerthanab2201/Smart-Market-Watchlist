import { ctx, notFound, enrich, marketState, requireWatchlist, NextResponse } from "@/lib/shared";
import { itemsFor, trackingSince, lastReviewedAt, LIVE_NS, demoNs } from "@/lib/db";
import { getProvider } from "@/lib/market";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, watchlist } = await ctx();
  // Never silently fall back: an explicit unknown ID is a 404.
  const wl = id ? requireWatchlist(user.id, id) : requireWatchlist(user.id, watchlist.id);
  if (!wl) return notFound();
  const ns = wl.is_demo ? demoNs(user.id) : LIVE_NS;
  const items = itemsFor(wl.id).map((i) => i.symbol);
  const quotes = enrich(items, ns, wl.id, user.id);
  const ms = marketState();
  const market = wl.is_demo
    ? { open: false, label: "Simulated session", note: "Scripted scenario; real exchange hours do not apply.", etNow: "" }
    : ms;
  return NextResponse.json({
    watchlist: { id: wl.id, name: wl.name, is_demo: !!wl.is_demo },
    items, quotes,
    trackingSince: trackingSince(wl.id, user.id),
    reviewedAt: lastReviewedAt(wl.id, user.id),
    market,
    mode: wl.is_demo ? "demo-simulated" : getProvider().kind === "finnhub" ? "real-provider" : "simulated",
  });
}
