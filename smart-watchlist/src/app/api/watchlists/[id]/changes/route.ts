import { ctx, notFound, requireWatchlist, enrich, NextResponse } from "@/lib/shared";
import {
  db, itemsFor, unreadEvents, unreadCount, trackingSince, lastReviewedAt,
  createSnapshot, latestQuote, coverageFor, displaySource, sourceTransitions,
  LIVE_NS, demoNs,
} from "@/lib/db";
import { companyName } from "@/lib/companies";

const BRIEF_LIMIT = 10;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await ctx();
  const wl = requireWatchlist(user.id, id);
  if (!wl) return notFound();
  const ns = wl.is_demo ? demoNs(user.id) : LIVE_NS;
  const symbols = itemsFor(wl.id).map((i) => i.symbol);
  const since = trackingSince(wl.id, user.id);

  if (!since) {
    return NextResponse.json({
      tracking: false, events: [], priorSourceEvents: [], baselines: {}, reviewToken: null,
      reviewedAt: null, unreadTotal: 0, coverage: null, sourceNotices: [],
    });
  }

  const unread = unreadEvents(ns, wl.id, user.id, symbols, BRIEF_LIMIT * 2);
  const total = unreadCount(ns, wl.id, user.id, symbols);

  // Partition: current display-source events vs earlier-source evidence.
  // Simulated history stays identifiable and separate from real unread events.
  const current: typeof unread = [];
  const prior: typeof unread = [];
  for (const e of unread) {
    (e.source === displaySource(ns, e.symbol) ? current : prior).push(e);
  }
  const shownCurrent = current.slice(0, BRIEF_LIMIT);
  const shownPrior = prior.slice(0, 5);

  // Exact baselines shown in this briefing; the review token binds them (plus
  // membership period and source generation) so acknowledgement commits
  // precisely what was displayed.
  const baselines: Record<string, { price: number; asOf: string; addedAt: string; source: string }> = {};
  const addedAt = new Map(
    (db().prepare("SELECT symbol, added_at FROM items WHERE watchlist_id = ?").all(wl.id) as unknown as { symbol: string; added_at: string }[])
      .map((r) => [r.symbol, r.added_at] as const)
  );
  for (const s of symbols) {
    const q = latestQuote(ns, s);
    if (q) baselines[s] = { price: Number(q.price), asOf: q.as_of, addedAt: addedAt.get(s) ?? since, source: displaySource(ns, s) };
  }
  const eventIds = [...shownCurrent, ...shownPrior].map((e) => e.id);
  const reviewToken = createSnapshot(wl.id, user.id, eventIds, baselines);

  const coverage = coverageFor(ns, since);
  const reviewedAt = lastReviewedAt(wl.id, user.id);
  const sourceNotices = sourceTransitions(ns, symbols)
    .filter((t) => !reviewedAt || t.at > reviewedAt)
    .map((t) => ({
      symbol: t.symbol,
      text: `Data source changed to Finnhub for ${t.symbol}. Start a new review baseline.`,
    }));

  const shape = (e: (typeof unread)[number]) => ({
    id: e.id, symbol: e.symbol, company: companyName(e.symbol),
    score: e.score, reasons: JSON.parse(e.reasons) as string[], summary: e.summary,
    observed_price: e.observed_price, baseline_price: e.baseline_price, baseline_kind: e.baseline_kind,
    components: JSON.parse(e.components) as Record<string, number>,
    source: e.source, occurred_at: e.occurred_at, version: e.version,
  });

  return NextResponse.json({
    tracking: true, trackingSince: since, reviewedAt,
    events: shownCurrent.map(shape), priorSourceEvents: shownPrior.map(shape),
    baselines, reviewToken, unreadTotal: total, coverage, sourceNotices,
    ...(new URL(req.url).searchParams.get("include") === "quotes"
      ? { quotes: enrich(symbols, ns, wl.id, user.id) }
      : {}),
  });
}
