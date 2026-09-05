import { ctx, NextResponse } from "@/lib/shared";
import { resetDemo, advanceDemo, injectDemoEvent } from "@/lib/demo";

// Demo controls are discrete and isolated to the caller's demo namespace:
//   reset   — flat baselines, tracking established, no events
//   advance — append the next scripted observation (never deletes evidence)
//   inject  — a fresh event "now", for demonstrating late arrivals
// Missing action defaults to reset-then-advance so one click shows a signal.
export async function POST(req: Request) {
  const { user } = await ctx();
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "start");
  if (action === "reset") return NextResponse.json({ ok: true, ...resetDemo(user.id) });
  if (action === "advance") return NextResponse.json({ ok: true, ...advanceDemo(user.id) });
  if (action === "inject") return NextResponse.json({ ok: true, ...injectDemoEvent(user.id) });
  if (action === "start") {
    resetDemo(user.id);
    return NextResponse.json({ ok: true, ...advanceDemo(user.id) });
  }
  return NextResponse.json({ error: 'unknown action; use "reset", "advance", or "inject"' }, { status: 400 });
}
