import { ctx, notFound, requireWatchlist, NextResponse } from "@/lib/shared";
import { itemsFor, startTracking, LIVE_NS, demoNs } from "@/lib/db";

/** Explicit first-review action: establishes the tracking baseline. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await ctx();
  const wl = requireWatchlist(user.id, id);
  if (!wl) return notFound();
  const ns = wl.is_demo ? demoNs(user.id) : LIVE_NS;
  const since = startTracking(wl.id, user.id, ns, itemsFor(wl.id).map((i) => i.symbol));
  return NextResponse.json({ ok: true, trackingSince: since });
}
