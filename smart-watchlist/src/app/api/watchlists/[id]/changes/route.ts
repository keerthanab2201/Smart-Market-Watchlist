import { ctx, notFound, requireWatchlist, enrich, NextResponse } from "@/lib/shared";
import {
  db, itemsFor, unreadEvents, unreadCount, trackingSince, lastReviewedAt,
  createSnapshot, latestQuote, coverageFor, LIVE_NS, demoNs,
} from "@/lib/db";
import { companyName } from "@/lib/companies";

const BRIEF_LIMIT = 10;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await ctx();
  const wl = requireWatchlist(user.id, id);
  if (!wl) return notFound();
  const ns = wl.is_demo ? demoNs(user.id) : LIVE_NS;
  const symbols = itemsFor(wl.id).map((i) => i.symbol);
  const since = trackingSince(wl.id, user.id);

  if (!since) {
    return NextResponse.json({
      tracking: false, events: [], baselines: {}, reviewToken: null,
      reviewedAt: null, unreadTotal: 0, coverage: null,
    });
  }

  const unread = unreadEvents(ns, wl.id, user.id, symbols, BRIEF_LIMIT);
  const total = unreadCount(ns, wl.id, user.id, symbols);

  // Exact baselines shown in this briefing; the review token binds them (plus
  // the membership period) so acknowledgement commits precisely what was shown.
  const baselines: Record<string, { price: number; asOf: string; addedAt: string }> = {};
  const addedAt = new Map(
    (db().prepare("SELECT symbol, added_at FROM items WHERE watchlist_id = ?").all(wl.id) as unknown as { symbol: string; added_at: string }[])
      .map((r) => [r.symbol, r.added_at] as const)
  );
  for (const s of symbols) {
    const q = latestQuote(ns, s);
    if (q) baselines[s] = { price: Number(q.price), asOf: q.as_of, addedAt: addedAt.get(s) ?? since };
  }
  const eventIds = unread.map((e) => e.id);
  const reviewToken = createSnapshot(wl.id, user.id, eventIds, baselines);

  const coverage = coverageFor(ns, since);

  const events = unread.map((e) => ({
    id: e.id, symbol: e.symbol, company: companyName(e.symbol),
    score: e.score, reasons: JSON.parse(e.reasons) as string[], summary: e.summary,
    observed_price: e.observed_price, baseline_price: e.baseline_price, baseline_kind: e.baseline_kind,
    components: JSON.parse(e.components) as Record<string, number>,
    source: e.source, occurred_at: e.occurred_at, version: e.version,
  }));

  return NextResponse.json({
    tracking: true, trackingSince: since, reviewedAt: lastReviewedAt(wl.id, user.id),
    events, baselines, reviewToken, unreadTotal: total, coverage,
    // One consistent snapshot: quotes read in the same request the token's
    // baselines were computed from, so acknowledgement commits exactly this.
    ...(new URL(_req.url).searchParams.get("include") === "quotes"
      ? { quotes: enrich(symbols, ns, wl.id, user.id) }
      : {}),
  });
}
