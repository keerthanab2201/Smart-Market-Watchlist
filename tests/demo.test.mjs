import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "sw-demo-"));
process.env.SW_DB_PATH = join(dir, "test.sqlite");

const db = await import("../smart-watchlist/src/lib/db.ts");
const demo = await import("../smart-watchlist/src/lib/demo.ts");

// Fixed clock: deterministic timestamps, no same-millisecond races.
const T0 = new Date("2026-09-01T14:00:00.000Z").getTime();
const tick = (n) => T0 + n * 60_000;

describe("demo scenario", () => {
  let user;
  before(() => {
    user = db.getOrCreateUser("demo-user-1");
  });

  it("reset establishes tracking with flat baselines and no events", () => {
    const r = demo.resetDemo(user.id, tick(0));
    assert.equal(r.action, "reset");
    assert.deepEqual(r.newEvents, []);
    assert.ok(db.trackingSince(r.watchlistId, user.id));
    assert.equal(db.unreadEvents(db.demoNs(user.id), r.watchlistId, user.id, ["DEMO", "NVDA", "AAPL"], 10).length, 0);
    for (const s of Object.values(r.scores)) assert.ok(s < 55, `flat seed scores below threshold, got ${s}`);
  });

  it("advance 1 spikes DEMO $100 → $108 with an event", () => {
    const r = demo.advanceDemo(user.id, tick(10));
    assert.equal(r.newEvents.length, 1);
    assert.ok(r.scores.DEMO > 85, `spike scores high, got ${r.scores.DEMO}`);
  });

  it("advance 2 returns to $101: spike preserved, ≈+1% since review", () => {
    const r = demo.advanceDemo(user.id, tick(20));
    assert.equal(r.newEvents.length, 0, "return leg must not create a second event");
    const wl = db.getDemoWatchlist(user.id);
    const unread = db.unreadEvents(db.demoNs(user.id), wl.id, user.id, ["DEMO", "NVDA", "AAPL"], 10);
    assert.equal(unread.length, 1, "earlier spike stays visible");
    assert.equal(unread[0].observed_price, 108);
    const base = db.baselineFor(wl.id, user.id, "DEMO");
    assert.ok(base, "review baseline exists from reset tracking");
    const pct = ((101 - base.price) / base.price) * 100;
    assert.ok(Math.abs(pct - 1) < 0.3, `≈+1% since review, got ${pct.toFixed(2)}%`);
  });

  it("advance appends without deleting earlier evidence", () => {
    const wl = db.getDemoWatchlist(user.id);
    const ns = db.demoNs(user.id);
    const r3 = demo.advanceDemo(user.id, tick(30));
    assert.equal(r3.newEvents.length, 1, "NVDA spike creates an event");
    const r4 = demo.advanceDemo(user.id, tick(40));
    assert.equal(r4.newEvents.length, 0, "quiet AAPL tick creates nothing");
    const unread = db.unreadEvents(ns, wl.id, user.id, ["DEMO", "NVDA", "AAPL"], 10);
    assert.equal(unread.length, 2, "both earlier events preserved");
    assert.ok(r4.nextHint.includes("complete"));
  });

  it("inject after a briefing, then ack earlier: new event stays unread", () => {
    const wl = db.getDemoWatchlist(user.id);
    const ns = db.demoNs(user.id);
    const shown = db.unreadEvents(ns, wl.id, user.id, ["DEMO", "NVDA", "AAPL"], 10);
    assert.ok(shown.length >= 2);
    const baselines = {};
    for (const s of ["DEMO", "NVDA", "AAPL"]) {
      const b = db.baselineFor(wl.id, user.id, s);
      if (b) baselines[s] = { price: b.price, asOf: b.as_of, addedAt: new Date(T0).toISOString() };
    }
    const tok = db.createSnapshot(wl.id, user.id, shown.map((e) => e.id), baselines);
    const inj = demo.injectDemoEvent(user.id, tick(50));
    assert.equal(inj.newEvents.length, 1, "inject creates a fresh event");
    const ack = db.ackSnapshot(user.id, wl.id, tok);
    assert.equal(ack.reviewed, shown.length);
    const rest = db.unreadEvents(ns, wl.id, user.id, ["DEMO", "NVDA", "AAPL"], 10).map((e) => e.id);
    assert.deepEqual(rest, inj.newEvents, "only the injected event remains unread");
  });

  it("reset clears demo evidence but live data is untouched", () => {
    const wl = db.getDemoWatchlist(user.id);
    const ns = db.demoNs(user.id);
    assert.ok(db.unreadEvents(ns, wl.id, user.id, ["DEMO"], 10).length >= 0);
    demo.resetDemo(user.id, tick(60));
    assert.equal(db.unreadEvents(ns, wl.id, user.id, ["DEMO", "NVDA", "AAPL"], 10).length, 0);
    const live = db.ensureDefaultWatchlist(user.id);
    assert.ok(!db.itemsFor(live.id).includes("DEMO"));
  });
});
