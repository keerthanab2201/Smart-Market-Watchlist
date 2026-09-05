import { ctx, notFound, requireWatchlist, NextResponse } from "@/lib/shared";
import { ackSnapshot, itemsFor, unreadCount, LIVE_NS, demoNs } from "@/lib/db";

/**
 * Acknowledge EXACTLY the briefing identified by the server-issued token.
 * Idempotent; late arrivals keep different IDs and stay unread; older tabs
 * cannot regress baselines (monotonic commit in ackSnapshot).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await ctx();
  const wl = requireWatchlist(user.id, id);
  if (!wl) return notFound();
  const body = await req.json().catch(() => ({}));
  const token = String(body.token ?? "");
  if (!token) return NextResponse.json({ error: "A review token from the current briefing is required" }, { status: 400 });
  const onlyIds = Array.isArray(body.eventIds)
    ? (body.eventIds as unknown[]).filter((n): n is number => Number.isInteger(n))
    : undefined;
  try {
    const { reviewed, already, reviewedAt } = ackSnapshot(user.id, wl.id, token, onlyIds);
    const ns = wl.is_demo ? demoNs(user.id) : LIVE_NS;
    const remaining = unreadCount(ns, wl.id, user.id, itemsFor(wl.id).map((i) => i.symbol));
    return NextResponse.json({ ok: true, reviewed, already, reviewedAt, remaining });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Review failed; nothing was acknowledged" }, { status: 409 });
  }
}
