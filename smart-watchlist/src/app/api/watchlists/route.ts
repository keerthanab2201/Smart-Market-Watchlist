import { ctx, NextResponse } from "@/lib/shared";
import { db, uid, nowISO } from "@/lib/db";

export async function POST(req: Request) {
  const { user } = await ctx();
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "My Watchlist").slice(0, 40) || "My Watchlist";
  const count = db().prepare("SELECT COUNT(*) AS n FROM watchlists WHERE user_id = ? AND is_demo = 0").get(user.id) as { n: number };
  if (count.n >= 10) return NextResponse.json({ error: "Watchlist limit reached" }, { status: 400 });
  const w = { id: uid(), user_id: user.id, name, created_at: nowISO() };
  db().prepare("INSERT INTO watchlists(id, user_id, name, is_demo, created_at) VALUES (?,?,?,?,?)")
    .run(w.id, user.id, w.name, 0, w.created_at);
  return NextResponse.json(w);
}

export async function GET() {
  const { watchlist } = await ctx();
  return NextResponse.json({ defaultWatchlistId: watchlist.id });
}
