import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "sw-review-"));
process.env.SW_DB_PATH = join(dir, "test.sqlite");

const db = await import("../smart-watchlist/src/lib/db.ts");

const T0 = new Date("2026-09-01T14:00:00.000Z").getTime();
const iso = (ms) => new Date(ms).toISOString();

function insertEv(symbol, occurred_at, score = 60, fp = `fp-${symbol}-${occurred_at}`) {
  return db.insertEvent({
    namespace: "live", symbol, score, reasons: "[]", summary: "e",
    observed_price: 1, baseline_price: 1, baseline_kind: "previous-observation",
    components: "{}", source: "simulated", occurred_at, fingerprint: fp, version: 2,
  });
}

describe("membership-aware briefing", () => {
  let u, wl;
  before(() => {
    u = db.getOrCreateUser("review-user");
    wl = db.ensureDefaultWatchlist(u.id);
    // Fixed-clock anchor; per-test symbols isolate timelines below.
    db.startTracking(wl.id, u.id, "live", [], iso(T0 - 60_000));
  });

  it("pre-addition events never consume briefing slots", () => {
    for (let i = 0; i < 12; i++) insertEv("PRE1", iso(T0 - (12 - i) * 1000));
    // Stock added after those events: they predate membership.
    db.addItem(wl.id, "PRE1");
    const unread = db.unreadEvents("live", wl.id, u.id, ["PRE1"], 10);
    assert.equal(unread.length, 0);
  });

  it("limit applies after membership filtering", () => {
    db.addItem(wl.id, "PRE2", iso(T0 - 120_000));
    for (let i = 0; i < 12; i++) insertEv("PRE2", iso(T0 + (i + 1) * 1000), 60 + i, `new-${i}`);
    const unread = db.unreadEvents("live", wl.id, u.id, ["PRE2"], 10);
    assert.equal(unread.length, 10);
    assert.equal(db.unreadCount("live", wl.id, u.id, ["PRE2"]), 12);
  });

  it("remove/re-add resets baselines and old tokens cannot restore them", () => {
    db.addItem(wl.id, "PRE3", iso(T0 - 120_000));
    db.removeItem(wl.id, u.id, "PRE3");
    db.addItem(wl.id, "PRE3");
    const added = db.itemAddedAt(wl.id, "PRE3");
    const snap = db.createSnapshot(wl.id, u.id, [], { PRE3: { price: 999, asOf: iso(T0), addedAt: "2000-01-01T00:00:00.000Z" } });
    const r = db.ackSnapshot(u.id, wl.id, snap);
    assert.equal(r.reviewed, 0);
    // Baseline from an earlier membership period must not be restored.
    assert.notEqual(db.baselineFor(wl.id, u.id, "PRE3")?.price, 999);
    assert.ok(added);
  });

  it("exact displayed prices are committed by the token", () => {
    const t = iso(T0 + 100_000);
    const addedAt = db.itemAddedAt(wl.id, "PRE2");
    const snap = db.createSnapshot(wl.id, u.id, [], { PRE2: { price: 42.5, asOf: t, addedAt } });
    db.ackSnapshot(u.id, wl.id, snap);
    assert.equal(db.baselineFor(wl.id, u.id, "PRE2")?.price, 42.5);
  });
});

describe("retention coverage honesty", () => {
  it("warns only when pruning actually overlaps tracking", () => {
    const quiet = db.coverageFor("live", iso(T0));
    assert.equal(quiet.incomplete, false);
    assert.equal(quiet.note, null);
    const u2 = db.getOrCreateUser("coverage-user");
    const wl2 = db.ensureDefaultWatchlist(u2.id);
    db.addItem(wl2.id, "COV");
    // Simulate a prune that deleted events inside this tracking window.
    const now = new Date(T0 + 1000).toISOString();
    db.startTracking(wl2.id, u2.id, "live", ["COV"]);
    db.setMeta("retention_last_prune", JSON.stringify({
      at: now, eventsCutoff: iso(T0 + 5000), quotesCutoff: iso(T0 + 5000), quotes: 3, events: 7,
    }));
    const gap = db.coverageFor("live", iso(T0));
    assert.equal(gap.incomplete, true);
    assert.ok(gap.note && gap.note.includes("coverage gap"));
  });
});
