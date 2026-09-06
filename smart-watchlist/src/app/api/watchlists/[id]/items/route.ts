import { ctx, notFound, requireWatchlist, NextResponse, normalizeSymbol, VALID_SYMBOLS } from "@/lib/shared";
import { addItem, itemsFor } from "@/lib/db";
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
  // Membership starts now; a review baseline requires an explicit review.
  return NextResponse.json({ symbol });
}
