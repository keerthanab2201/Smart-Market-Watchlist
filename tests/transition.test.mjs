import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "sw-trans-"));
process.env.SW_DB_PATH = join(dir, "test.sqlite");

const db = await import("../smart-watchlist/src/lib/db.ts");
const ingest = await import("../smart-watchlist/src/lib/ingest.ts");
const fmt = await import("../smart-watchlist/src/lib/format.ts");
const demo = await import("../smart-watchlist/src/lib/demo.ts");

const T0 = new Date("2026-09-04T20:00:00.000Z").getTime(); // Friday session
const iso = (ms) => new Date(ms).toISOString();

function simObs(symbol, price, volume, asOf) {
  return {
    symbol, price, volume, asOf, fetchedAt: asOf, source: "simulated",
    prevClose: null, delaySec: null, asOfSource: "provider",
  };
}

function finnhubObs(symbol, price, asOf, prevClose = null) {
  return {
    symbol, price, volume: null, asOf, fetchedAt: asOf, source: "finnhub",
    prevClose, delaySec: 60, asOfSource: "provider",
  };
}

describe("sim-to-finnhub transition", () => {
  let u, wl;
  const NS = "live";
  before(() => {
    u = db.getOrCreateUser("trans-user");
    wl = db.ensureDefaultWatchlist(u.id);
    for (const s of ["PRE", "OLD", "DUP", "MIX", "TOK", "SHUT"]) db.addItem(wl.id, s, iso(T0 - 3600_000));
    db.startTracking(wl.id, u.id, NS, ["PRE", "OLD", "DUP", "MIX", "TOK", "SHUT"], iso(T0 - 1800_000));
    // Simulated era: newer timestamps than the coming session quote.
    for (let i = 0; i < 8; i++) {
      db.scoreAndStore(NS, simObs("PRE", 100 + i * 0.2, 1_000_000, iso(T0 + 3600_000 + i * 60_000)));
      db.scoreAndStore(NS, simObs("OLD", 50, 500_000, iso(T0 + 3600_000 + i * 60_000)));
    }
  });

  it("1. pre-finnhub stock receives a real quote afterward", () => {
    const r = db.scoreAndStore(NS, finnhubObs("PRE", 101.5, iso(T0)));
    assert.ok(r.accepted, `finnhub session quote accepted despite newer sim rows: ${r.reason}`);
    assert.equal(r.transitioned, true);
  });

  it("2. earlier finnhub quote supersedes newer sim in display", () => {
    const shown = db.displayQuote(NS, "PRE");
    assert.ok(shown);
    assert.equal(shown.source, "finnhub");
    assert.equal(shown.price, 101.5);
    assert.equal(db.displaySource(NS, "PRE"), "finnhub");
  });

  it("3. older quotes from the same real stream stay rejected", () => {
    const r = db.scoreAndStore(NS, finnhubObs("PRE", 99, iso(T0 - 86_400_000)));
    assert.equal(r.accepted, false);
    assert.match(r.reason ?? "", /same|older/i);
  });

  it("4. identical repeats create no new observations or samples", () => {
    const n0 = db.readBaseline(NS, "PRE");
    const q0 = db.recentQuotes(NS, "PRE", 50, "finnhub").length;
    const r = db.scoreAndStore(NS, finnhubObs("PRE", 101.5, iso(T0)));
    assert.equal(r.accepted, false);
    assert.equal(r.duplicate, true);
    assert.deepEqual(db.readBaseline(NS, "PRE"), n0);
    assert.equal(db.recentQuotes(NS, "PRE", 50, "finnhub").length, q0);
  });

  it("5. one symbol's failure does not block others", async () => {
    ingest.resetIngestFlight();
    const flaky = {
      name: "flaky", kind: "simulated",
      supports: () => true,
      async getQuote(symbol) {
        if (symbol === "SHUT") throw new Error("boom");
        return {
          symbol, price: 10, volume: 100, asOf: new Date(T0 + 7200_000),
          source: "simulated", prevClose: null, delaySec: null, asOfSource: "provider",
        };
      },
      async getHistory() { return []; },
    };
    const r = await ingest.runIngestAsync("live", flaky);
    assert.ok(r.symbols.includes("SHUT") && r.symbols.includes("MIX"));
    const shut = db.fetchStatus("live", "SHUT");
    const mix = db.fetchStatus("live", "MIX");
    assert.equal(shut?.outcome, "error");
    assert.equal(mix?.outcome, "accepted");
    ingest.resetIngestFlight();
  });

  it("6. simulated statistics do not contaminate real scoring", () => {
    const base = db.readBaseline(NS, "PRE");
    // Only the single finnhub observation feeds the fresh stream.
    assert.equal(base.n_ret, 0);
    assert.equal(base.n_vol, 0);
    assert.equal(base.range_n, 1);
  });

  it("7. old tokens cannot restore simulated baselines after transition", () => {
    // A token built pre-transition carries a simulated-generation baseline.
    const snap = db.createSnapshot(wl.id, u.id, [], {
      PRE: { price: 100, asOf: iso(T0 + 3600_000), addedAt: iso(T0 - 3600_000), source: "simulated" },
    });
    db.ackSnapshot(u.id, wl.id, snap);
    // Display generation is now finnhub: the stale token must not restore one.
    assert.equal(db.baselineFor(wl.id, u.id, "PRE"), null);
  });

  it("8. closed-market responses preserve timestamps and fetch health", () => {
    const r = db.scoreAndStore(NS, finnhubObs("OLD", 51, iso(T0)));
    assert.ok(r.accepted);
    const q = db.displayQuote(NS, "OLD");
    assert.equal(q?.as_of, iso(T0), "provider timestamp preserved, not invented");
    db.recordFetch(NS, "OLD", {
      attemptAt: iso(T0 + 3600_000), provider: "finnhub", outcome: "duplicate",
      providerAsOf: iso(T0), reason: null,
    });
    const f = db.fetchStatus(NS, "OLD");
    assert.equal(f?.outcome, "duplicate");
    assert.equal(f?.providerAsOf, iso(T0));
  });

  it("9. missing evidence renders Insufficient history", () => {
    assert.equal(fmt.scoreLabel(0, ["baseline"]), "Insufficient history");
    assert.equal(fmt.scoreLabel(0, ["volatility"]), "Insufficient history");
    assert.equal(fmt.scoreLabel(0, []), "0");
    assert.equal(fmt.scoreLabel(42, []), "42");
  });

  it("10. demo and live namespaces stay isolated", () => {
    const r = demo.resetDemo(u.id, T0 + 10_000_000);
    assert.ok(r.watchlistId !== wl.id);
    const livePRE = db.displayQuote("live", "PRE");
    assert.equal(livePRE?.source, "finnhub", "live stream untouched by demo reset");
  });
});

describe("legacy duplicate cleanup", () => {
  it("collapses same-key observations/events with backup, keeps earliest", () => {
    const T = iso(T0 + 9000_000);
    for (let i = 0; i < 3; i++) {
      db.insertQuote("live", {
        symbol: "DUPX", price: 10, volume: 5, as_of: T, fetched_at: T,
        source: "finnhub", prev_close: null, delay_sec: null, as_of_source: "provider",
      });
    }
    const e1 = db.insertEvent({
      namespace: "live", symbol: "DUPX", score: 60, reasons: "[]", summary: "s",
      observed_price: 10, baseline_price: 9, baseline_kind: "x",
      components: "{}", source: "finnhub", occurred_at: T, fingerprint: "dupfp", version: 2,
    });
    const e2 = db.insertEvent({
      namespace: "live", symbol: "DUPX", score: 70, reasons: "[]", summary: "s",
      observed_price: 10, baseline_price: 9, baseline_kind: "x",
      components: "{}", source: "finnhub", occurred_at: T, fingerprint: "dupfp", version: 2,
    });
    const r = db.collapseDuplicateObservations();
    assert.ok(r.quotes >= 2 && r.events >= 1);
    assert.ok(r.backupKey.startsWith("dedupe_backup:"));
    const h = db.db();
    const qLeft = h.prepare("SELECT COUNT(*) AS n FROM quotes WHERE namespace='live' AND symbol='DUPX'").get().n;
    assert.equal(qLeft, 1);
    const eLeft = h.prepare("SELECT id FROM events WHERE namespace='live' AND symbol='DUPX'").all().map((x) => x.id);
    assert.deepEqual(eLeft, [Math.min(e1, e2)]);
    const bak = JSON.parse(h.prepare("SELECT value FROM meta WHERE key=?").get(r.backupKey).value);
    assert.ok(bak.quotes.length >= 2 && bak.events.length >= 1);
    // Second pass is a no-op.
    const r2 = db.collapseDuplicateObservations();
    assert.equal(r2.quotes, 0);
    assert.equal(r2.events, 0);
  });
});

describe("review provenance regressions", () => {
  it("explicit tracking selects Finnhub despite a newer simulated timestamp", () => {
    const u=db.getOrCreateUser("real-baseline"); const w=db.ensureDefaultWatchlist(u.id);
    db.scoreAndStore("live",simObs("TSLA",245.29,100,iso(T0+3600000)));
    db.scoreAndStore("live",finnhubObs("TSLA",354.08,iso(T0)));
    db.startTracking(w.id,u.id,"live",["TSLA"]);
    const b=db.baselineFor(w.id,u.id,"TSLA");
    assert.equal(b.price,354.08);assert.equal(b.source,"finnhub");
    assert.equal(b.membership_id,db.itemsFor(w.id).find(i=>i.symbol==="TSLA").id);
  });
  it("first real score cannot use a mature simulated range", () => {
    for(let i=0;i<9;i++)db.scoreAndStore("live",simObs("FIRST",100+i,1000,iso(T0+i*1000)));
    const result=db.scoreAndStore("live",finnhubObs("FIRST",354,iso(T0-1000)));
    const ev=JSON.parse(db.readScore("live","FIRST",result.quoteId).evidence);
    assert.equal(ev.nRet,0);assert.equal(ev.rangeN,0);assert.equal(ev.rangeHi,null);
  });
  it("same-millisecond removal and re-add cannot restore an old token", () => {
    const u=db.getOrCreateUser("membership-id"); const w=db.ensureDefaultWatchlist(u.id);const at=iso(T0);
    db.addItem(w.id,"MEM",at);db.scoreAndStore("live",simObs("MEM",100,100,at));
    const old=db.itemsFor(w.id).find(i=>i.symbol==="MEM").id;
    const token=db.createSnapshot(w.id,u.id,[],{MEM:{price:100,asOf:at,addedAt:at}});
    db.removeItem(w.id,u.id,"MEM");db.addItem(w.id,"MEM",at);db.ackSnapshot(u.id,w.id,token);
    assert.notEqual(db.itemsFor(w.id).find(i=>i.symbol==="MEM").id,old);assert.equal(db.baselineFor(w.id,u.id,"MEM"),null);
    assert.equal(db.recentQuotes("live","MEM",10).length,1);
  });
  it("conflicting payload at the same observation timestamp is rejected",()=>{
    db.scoreAndStore("live",finnhubObs("CONFLICT",100,iso(T0)));
    const r=db.scoreAndStore("live",finnhubObs("CONFLICT",101,iso(T0)));
    assert.equal(r.accepted,false);assert.equal(db.recentQuotes("live","CONFLICT",20).length,1);
  });
  it("missing evidence and absent volume never claim normal trading",()=>{
    assert.equal(fmt.describeEvidence({dayChangePct:0,missing:["volatility"],volRatio:null,source:"finnhub"}),"Not enough distinct observations to assess recent price behavior.");
    assert.match(fmt.describeEvidence({dayChangePct:1,missing:[],volRatio:null,source:"finnhub"}),/Volume is not supplied by this feed/);
  });
  it("Friday quote remains last-session on Sunday; prior week is stale",()=>{
    const now=new Date("2026-09-06T08:00:00Z").getTime();
    assert.match(fmt.describeQuoteStatus(iso(T0),"finnhub",false,now).detail,/Last session/);
    assert.equal(fmt.describeQuoteStatus(iso(T0-7*86400000),"finnhub",false,now).kind,"stale");
  });
  it("fetch failure preserves the last successful check",()=>{
    db.recordFetch("live","HEALTH",{attemptAt:iso(T0),provider:"finnhub",outcome:"duplicate",providerAsOf:iso(T0),reason:null});
    db.recordFetch("live","HEALTH",{attemptAt:iso(T0+1000),provider:"finnhub",outcome:"error",providerAsOf:null,reason:"failed"});
    assert.equal(db.fetchStatus("live","HEALTH").lastSuccessAt,iso(T0));
  });
});
