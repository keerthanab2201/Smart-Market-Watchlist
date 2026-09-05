import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "sw-test-"));
process.env.SW_DB_PATH = join(dir, "test.sqlite");

const db = await import("../smart-watchlist/src/lib/db.ts");

describe("ownership isolation", () => {
  let a, b, wlA, wlB;
  before(() => {
    a = db.getOrCreateUser("token-a");
    b = db.getOrCreateUser("token-b");
    wlA = db.ensureDefaultWatchlist(a.id);
    wlB = db.ensureDefaultWatchlist(b.id);
  });

  it("user A cannot resolve user B's watchlist id", () => {
    assert.equal(db.getOwnedWatchlist(a.id, wlB.id), null);
    assert.ok(db.getOwnedWatchlist(b.id, wlB.id));
  });

  it("unique membership constraint rejects duplicates, including racing inserts", async () => {
    const results = await Promise.all([
      Promise.resolve(db.addItem(wlA.id, "PLTR")),
      Promise.resolve(db.addItem(wlA.id, "PLTR")),
      Promise.resolve(db.addItem(wlA.id, "PLTR")),
    ]);
    assert.equal(results.filter((r) => r.created).length, 1);
    const rows = db.itemsFor(wlA.id).filter((i) => i.symbol === "PLTR");
    assert.equal(rows.length, 1);
  });

  it("reviews are per-user: acking A never touches B", () => {
    db.startTracking(wlA.id, a.id, "live", ["NVDA"]);
    db.startTracking(wlB.id, b.id, "live", ["NVDA"]);
    const now = new Date().toISOString();
    const idA = db.insertEvent({
      namespace: "live", symbol: "NVDA", score: 90, reasons: JSON.stringify(["sized_move"]),
      summary: "s", observed_price: 100, baseline_price: 90, baseline_kind: "previous-observation",
      components: JSON.stringify({}), source: "simulated", occurred_at: now,
      fingerprint: `fp-a-${now}`, version: 2,
    });
    const tok = db.createSnapshot(wlA.id, a.id, [idA], {});
    db.ackSnapshot(a.id, wlA.id, tok);
    // B still has it unread; A does not.
    assert.equal(db.unreadEvents("live", wlB.id, b.id, ["NVDA"], 10).length, 1);
    assert.equal(db.unreadEvents("live", wlA.id, a.id, ["NVDA"], 10).length, 0);
  });
});

describe("review token semantics", () => {
  let u, wl;
  before(() => {
    u = db.getOrCreateUser("token-c");
    wl = db.ensureDefaultWatchlist(u.id);
    db.addItem(wl.id, "TSLA");
    db.startTracking(wl.id, u.id, "live", ["TSLA"]);
  });

  it("ack covers exactly the snapshot; later arrivals stay unread", () => {
    // Anchor event times after tracking/membership began (see before hook).
    const t0 = new Date(Date.now() + 5000).toISOString();
    const e1 = db.insertEvent({
      namespace: "live", symbol: "TSLA", score: 60, reasons: "[]", summary: "e1",
      observed_price: 1, baseline_price: 1, baseline_kind: "previous-observation",
      components: "{}", source: "simulated", occurred_at: t0, fingerprint: `fp1-${t0}`, version: 2,
    });
    // Prove the event is unread before acknowledgement happens.
    assert.deepEqual(db.unreadEvents("live", wl.id, u.id, ["TSLA"], 10).map((e) => e.id), [e1]);
    const snap = db.createSnapshot(wl.id, u.id, [e1], { TSLA: { price: 1, asOf: t0 } });
    const t1 = new Date().toISOString();
    const e2 = db.insertEvent({
      namespace: "live", symbol: "TSLA", score: 70, reasons: "[]", summary: "e2",
      observed_price: 1, baseline_price: 1, baseline_kind: "previous-observation",
      components: "{}", source: "simulated", occurred_at: t1, fingerprint: `fp2-${t1}`, version: 2,
    });
    const r = db.ackSnapshot(u.id, wl.id, snap);
    assert.equal(r.reviewed, 1);
    const unread = db.unreadEvents("live", wl.id, u.id, ["TSLA"], 10).map((e) => e.id);
    assert.deepEqual(unread, [e2]);
  });

  it("re-ack with real ids reports nothing new the second time", () => {
    const t = new Date(Date.now() + 7000).toISOString();
    const e = db.insertEvent({
      namespace: "live", symbol: "TSLA", score: 61, reasons: "[]", summary: "re-ack",
      observed_price: 1, baseline_price: 1, baseline_kind: "previous-observation",
      components: "{}", source: "simulated", occurred_at: t, fingerprint: `reack-${t}`, version: 2,
    });
    const snap = db.createSnapshot(wl.id, u.id, [e], {});
    const r1 = db.ackSnapshot(u.id, wl.id, snap);
    assert.deepEqual([r1.reviewed, r1.already], [1, 0]);
    const r2 = db.ackSnapshot(u.id, wl.id, snap);
    assert.deepEqual([r2.reviewed, r2.already], [0, 1]);
  });

  it("re-ack is an idempotent no-op success", () => {
    const snap = db.createSnapshot(wl.id, u.id, [], {});
    const r1 = db.ackSnapshot(u.id, wl.id, snap);
    const r2 = db.ackSnapshot(u.id, wl.id, snap);
    assert.equal(r1.reviewed, 0);
    assert.equal(r2.reviewed, 0);
  });

  it("older snapshots cannot regress baselines", () => {
    db.addItem(wl.id, "MSNAP");
    const old = new Date(Date.now() - 3600_000).toISOString();
    const now = new Date().toISOString();
    const addedAt = db.itemAddedAt(wl.id, "MSNAP");
    const sOld = db.createSnapshot(wl.id, u.id, [], { MSNAP: { price: 100, asOf: old, addedAt } });
    const sNew = db.createSnapshot(wl.id, u.id, [], { MSNAP: { price: 200, asOf: now, addedAt } });
    db.ackSnapshot(u.id, wl.id, sNew);
    db.ackSnapshot(u.id, wl.id, sOld); // stale tab retries
    assert.equal(db.baselineFor(wl.id, u.id, "MSNAP")?.price, 200);
  });

  it("reversal evidence survives after the latest quote moves back", () => {
    const t = new Date(Date.now() + 5000).toISOString();
    const id = db.insertEvent({
      namespace: "live", symbol: "TSLA", score: 88, reasons: JSON.stringify(["sized_move"]),
      summary: "spike +8%", observed_price: 108, baseline_price: 100,
      baseline_kind: "previous-observation", components: "{}", source: "simulated",
      occurred_at: t, fingerprint: `rev-${t}`, version: 2,
    });
    // The market reverses: latest quote falls back while the event persists.
    db.insertQuote("live", {
      symbol: "TSLA", price: 101, volume: 1000,
      as_of: new Date(Date.now() + 6000).toISOString(), fetched_at: new Date().toISOString(),
      source: "simulated", prev_close: null, delay_sec: null, as_of_source: "provider",
    });
    const unread = db.unreadEvents("live", wl.id, u.id, ["TSLA"], 10);
    const ev = unread.find((e) => e.id === id);
    assert.ok(ev);
    assert.equal(ev.observed_price, 108); // immutable evidence, not rewritten
  });
});

describe("quote validation guards", () => {
  it("rejects bad payloads (imported from market module)", async () => {
    const m = await import("../smart-watchlist/src/lib/market.ts");
    assert.deepEqual(m.validateQuote({ symbol: "X", price: 0, volume: 1, asOf: new Date(), source: "simulated", prevClose: null, delaySec: null }), { ok: false, reason: "non-positive price" });
    assert.deepEqual(m.validateQuote({ symbol: "X", price: 10, volume: -1, asOf: new Date(), source: "simulated", prevClose: null, delaySec: null }), { ok: false, reason: "invalid volume" });
    assert.deepEqual(m.validateQuote({ symbol: "X", price: 10, volume: 1, asOf: new Date(Date.now() + 3600_000), source: "simulated", prevClose: null, delaySec: null }).ok, false);
    assert.equal(m.validateQuote({ symbol: "X", price: 10, volume: 1, asOf: new Date(), source: "simulated", prevClose: null, delaySec: null }).ok, true);
  });
});
