import {
  db, addItem, itemsFor, getDemoWatchlist, demoNs, clearNamespace,
  startTracking, scoreAndStore, type Observation,
} from "./db";

export const DEMO_SYMBOLS = ["DEMO", "NVDA", "AAPL"] as const;

interface FlatSeed { closes: number[]; vol: number }

const FLAT: Record<string, FlatSeed> = {
  // Small deterministic wiggle: nonzero volatility without triggering events.
  DEMO: { closes: [99.8, 100.1, 99.9, 100.2, 99.7, 100.0, 100.1], vol: 1_000_000 },
  NVDA: { closes: [129.8, 130.1, 129.9, 130.2, 129.7, 130.0, 130.1], vol: 200_000_000 },
  AAPL: { closes: [231.8, 232.1, 231.9, 232.2, 231.7, 232.0, 232.1], vol: 50_000_000 },
};

export interface DemoStep {
  symbol: string; price: number; volume: number | null; hint: string;
}

// Deterministic script. Step 1 spikes DEMO $100 → $108 (event); step 2
// returns to $101 (no new event; ≈+1% since the $100 review baseline while
// the spike stays preserved); step 3 adds an NVDA event; step 4 is quiet.
const SCRIPT: DemoStep[] = [
  { symbol: "DEMO", price: 108, volume: 4_200_000, hint: "Spike DEMO to $108 on heavy volume" },
  { symbol: "DEMO", price: 101, volume: 1_050_000, hint: "Return DEMO to $101 — spike stays in the briefing" },
  { symbol: "NVDA", price: 142, volume: 620_000_000, hint: "Spike NVDA on 3× volume" },
  { symbol: "AAPL", price: 232.5, volume: 51_000_000, hint: "Quiet AAPL tick — no new signal expected" },
];

const STEP_KEY = (ns: string) => `demo_step:${ns}`;

function stepOf(ns: string): number {
  const row = db().prepare("SELECT value FROM meta WHERE key = ?").get(STEP_KEY(ns)) as { value: string } | undefined;
  return row ? Number(JSON.parse(row.value).step) || 0 : 0;
}

function setStep(ns: string, step: number): void {
  db().prepare("INSERT INTO meta(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(STEP_KEY(ns), JSON.stringify({ step }));
}

export interface DemoResult {
  watchlistId: string; action: string; step: number; stepsTotal: number;
  newEvents: number[]; scores: Record<string, number>; nextHint: string | null; at: string;
}

function obsFor(symbol: string, price: number, volume: number | null, asOf: string): Observation {
  return {
    symbol, price, volume, asOf, fetchedAt: asOf, source: "demo",
    prevClose: null, delaySec: null, asOfSource: "provider",
  };
}

/**
 * Reset: flat deterministic baselines, no events, tracking established.
 * Confined to the caller's demo namespace; live data untouched.
 */
export function resetDemo(userId: string, nowMs = Date.now()): DemoResult {
  const wl = getDemoWatchlist(userId);
  const ns = demoNs(userId);
  const now = new Date(nowMs).toISOString();
  clearNamespace(ns);
  db().prepare("DELETE FROM briefing_snapshots WHERE watchlist_id = ?").run(wl.id);
  const h = db();
  for (const sym of DEMO_SYMBOLS) {
    addItem(wl.id, sym);
    h.prepare("UPDATE items SET added_at = ? WHERE watchlist_id = ? AND symbol = ?").run(now, wl.id, sym);
    const seed = FLAT[sym];
    seed.closes.forEach((price, i) => {
      scoreAndStore(ns, obsFor(sym, price, seed.vol, new Date(nowMs - (seed.closes.length - i) * 60_000).toISOString()));
    });
  }
  // Natural samples from the flat closes are the honest baseline — no seeding.
  // Tracking is established here, before any event can exist.
  startTracking(wl.id, userId, ns, [...DEMO_SYMBOLS], now);
  setStep(ns, 0);
  return {
    watchlistId: wl.id, action: "reset", step: 0, stepsTotal: SCRIPT.length,
    newEvents: [], scores: currentScores(ns, wl.id),
    nextHint: `Step 1 of ${SCRIPT.length}: ${SCRIPT[0].hint}.`, at: now,
  };
}

/** Advance: append the next scripted observation without deleting evidence. */
export function advanceDemo(userId: string, nowMs = Date.now()): DemoResult {
  const wl = getDemoWatchlist(userId);
  const ns = demoNs(userId);
  const step = stepOf(ns);
  if (step >= SCRIPT.length) {
    return {
      watchlistId: wl.id, action: "advance", step, stepsTotal: SCRIPT.length,
      newEvents: [], scores: currentScores(ns, wl.id),
      nextHint: "Scenario complete — inject a new event or reset the demo.", at: new Date(nowMs).toISOString(),
    };
  }
  const s = SCRIPT[step];
  // Monotonic per step even if two advances land in the same millisecond.
  const asOf = new Date(nowMs + step * 1000).toISOString();
  const res = scoreAndStore(ns, obsFor(s.symbol, s.price, s.volume, asOf));
  setStep(ns, step + 1);
  const next = step + 1 < SCRIPT.length ? `Step ${step + 2} of ${SCRIPT.length}: ${SCRIPT[step + 1].hint}.` : "Scenario complete — inject a new event or reset the demo.";
  return {
    watchlistId: wl.id, action: "advance", step: step + 1, stepsTotal: SCRIPT.length,
    newEvents: res.eventId != null ? [res.eventId] : [],
    scores: currentScores(ns, wl.id), nextHint: next, at: asOf,
  };
}

/** Inject: a fresh event "now", for demonstrating late arrivals during review. */
export function injectDemoEvent(userId: string, nowMs = Date.now()): DemoResult {
  const wl = getDemoWatchlist(userId);
  const ns = demoNs(userId);
  const asOf = new Date(nowMs).toISOString();
  const h = db();
  const last = h.prepare("SELECT price FROM quotes WHERE namespace = ? AND symbol = 'DEMO' ORDER BY as_of DESC, id DESC LIMIT 1")
    .get(ns) as { price: number } | undefined;
  const price = last && last.price >= 112 ? Math.round(last.price * 1.1 * 100) / 100 : 112;
  const res = scoreAndStore(ns, obsFor("DEMO", price, 4_400_000, asOf));
  return {
    watchlistId: wl.id, action: "inject", step: stepOf(ns), stepsTotal: SCRIPT.length,
    newEvents: res.eventId != null ? [res.eventId] : [],
    scores: currentScores(ns, wl.id),
    nextHint: res.eventId != null ? "New event injected — refetch the briefing, then acknowledge the earlier one." : "Injected tick produced no event (dedupe held) — advance or reset.",
    at: asOf,
  };
}

function currentScores(ns: string, watchlistId: string): Record<string, number> {
  // Read persisted totals for the latest quote of each demo symbol.
  const out: Record<string, number> = {};
  const h = db();
  for (const sym of itemsFor(watchlistId).map((i) => i.symbol)) {
    const q = h.prepare("SELECT id FROM quotes WHERE namespace = ? AND symbol = ? ORDER BY as_of DESC, id DESC LIMIT 1")
      .get(ns, sym) as { id: number } | undefined;
    const s = q ? h.prepare("SELECT score FROM quote_scores WHERE namespace = ? AND symbol = ? AND quote_id = ?")
      .get(ns, sym, q.id) as { score: number } | undefined : undefined;
    out[sym] = s ? Math.round(s.score) : 0;
  }
  return out;
}
