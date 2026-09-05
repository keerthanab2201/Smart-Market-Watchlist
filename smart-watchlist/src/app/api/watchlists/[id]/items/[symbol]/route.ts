import { ctx, notFound, requireWatchlist, NextResponse } from "@/lib/shared";
import { removeItem } from "@/lib/db";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; symbol: string }> }) {
  const { id, symbol } = await params;
  const { user } = await ctx();
  const wl = requireWatchlist(user.id, id);
  if (!wl) return notFound();
  const sym = decodeURIComponent(symbol).toUpperCase();
  const removed = removeItem(wl.id, user.id, sym);
  if (!removed) return NextResponse.json({ error: `"${sym}" is not in this watchlist` }, { status: 404 });
  // Removal semantics: membership ends, but already-reviewed history is kept.
  // Re-adding starts fresh tracking from the re-add time.
  return NextResponse.json({ removed: sym });
}
