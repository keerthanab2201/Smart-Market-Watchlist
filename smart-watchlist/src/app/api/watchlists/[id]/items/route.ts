import { ctx, notFound, requireWatchlist, NextResponse, normalizeSymbol, VALID_SYMBOLS } from "@/lib/shared";
import { db, addItem, itemsFor, latestQuote, LIVE_NS, demoNs } from "@/lib/db";
import { companyName } from "@/lib/companies";

const MAX_ITEMS = 50;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await ctx();
  const wl = requireWatchlist(user.id, id);
  if (!wl) return notFound();
  const body = await req.json().catch(() => ({}));
  const symbol = normalizeSymbol(String(body.symbol ?? ""));
  if (!symbol || symbol.length > 12) {
    return NextResponse.json({ error: "Enter a valid ticker symbol, e.g. AAPL" }, { status: 400 });
  }
  // Strict instrument lookup: never manufacture quotes for invalid symbols.
  if (!VALID_SYMBOLS.has(symbol) && !companyName(symbol)) {
    return NextResponse.json({ error: `Unknown symbol "${symbol}". Check the ticker and retry.` }, { status: 404 });
  }
  if (itemsFor(wl.id).length >= MAX_ITEMS) {
    return NextResponse.json({ error: `Watchlist limit is ${MAX_ITEMS} symbols` }, { status: 400 });
  }
  const { created } = addItem(wl.id, symbol);
  if (!created) return NextResponse.json({ symbol, deduped: true });
  // A new item's tracking starts at addition: baseline it to the latest quote
  // so pre-addition events are never presented as new.
  const ns = wl.is_demo ? demoNs(user.id) : LIVE_NS;
  const q = latestQuote(ns, symbol);
  if (q) {
    db().prepare(`INSERT INTO item_baselines(watchlist_id, user_id, symbol, price, quote_id, as_of)
      VALUES (?,?,?,?,?,?) ON CONFLICT(watchlist_id, user_id, symbol) DO NOTHING`)
      .run(wl.id, user.id, symbol, q.price, q.id, q.as_of);
  }
  return NextResponse.json({ symbol });
}
