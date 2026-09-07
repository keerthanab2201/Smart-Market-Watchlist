import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "sw-ingest-"));
process.env.SW_DB_PATH = join(dir, "test.sqlite");

const db = await import("../smart-watchlist/src/lib/db.ts");
const ingest = await import("../smart-watchlist/src/lib/ingest.ts");

describe("ingest authorization", () => {
  it("rejects when no secret is configured", () => {
    delete process.env.INGEST_SECRET;
    assert.equal(db.authorizeIngest(new Request("http://x/api/ingest", { method: "POST" })), false);
  });

  it("rejects wrong secrets, accepts the configured one", () => {
    process.env.INGEST_SECRET = "s3cret";
    const bad = new Request("http://x/api/ingest", { method: "POST", headers: { "x-ingest-secret": "nope" } });
    const missing = new Request("http://x/api/ingest", { method: "POST" });
    const good = new Request("http://x/api/ingest", { method: "POST", headers: { "x-ingest-secret": "s3cret" } });
    assert.equal(db.authorizeIngest(bad), false);
    assert.equal(db.authorizeIngest(missing), false);
    assert.equal(db.authorizeIngest(good), true);
    delete process.env.INGEST_SECRET;
  });
});

describe("scoreAndStore write path", () => {
  const NS = "live";
  before(() => {
    const u = db.getOrCreateUser("ingest-user");
    const wl = db.ensureDefaultWatchlist(u.id);
    db.addItem(wl.id, "STOR");
    db.startTracking(wl.id, u.id, NS, ["STOR"]);
  });

  function obs(symbol, price, volume, asOf) {
    return {
      symbol, price, volume, asOf, fetchedAt: asOf, source: "simulated",
      prevClose: null, delaySec: null, asOfSource: "provider",
    };
  }

  it("rejects older timestamps without mutating statistics", () => {
    const t0 = new Date("2026-09-01T10:00:00Z").toISOString();
    const t1 = new Date("2026-09-01T10:01:00Z").toISOString();
    const tOld = new Date("2026-09-01T09:59:00Z").toISOString();
    assert.ok(db.scoreAndStore(NS, obs("STOR", 100, 1000, t0)).accepted);
    assert.ok(db.scoreAndStore(NS, obs("STOR", 101, 1000, t1)).accepted);
    const before = db.readBaseline(NS, "STOR");
    const rej = db.scoreAndStore(NS, obs("STOR", 50, 1000, tOld));
    assert.equal(rej.accepted, false);
    assert.deepEqual(db.readBaseline(NS, "STOR"), before);
  });

  it("duplicate observations are idempotent", () => {
    const t = new Date("2026-09-01T11:00:00Z").toISOString();
    const first = db.scoreAndStore(NS, obs("STOR", 102, 1000, t));
    assert.ok(first.accepted);
    const dup = db.scoreAndStore(NS, obs("STOR", 102, 1000, t));
    assert.equal(dup.accepted, false);
    assert.equal(dup.duplicate, true);
    const rows = db.recentQuotes(NS, "STOR", 50).filter((q) => q.as_of === t);
    assert.equal(rows.length, 1);
  });

  it("keeps unknown volume as null", () => {
    const t = new Date("2026-09-01T12:00:00Z").toISOString();
    const r = db.scoreAndStore(NS, obs("STOR", 103, null, t));
    assert.ok(r.accepted);
    const stored = db.latestQuote(NS, "STOR");
    assert.equal(stored.volume, null);
  });

  it("persisted score matches the stored observation exactly", () => {
    const t = new Date("2026-09-01T13:00:00Z").toISOString();
    const r = db.scoreAndStore(NS, obs("STOR", 104, 1200, t));
    assert.ok(r.accepted && r.scored);
    const persisted = db.readScore(NS, "STOR", r.quoteId);
    assert.ok(persisted);
    assert.equal(persisted.score, r.scored.total);
    assert.equal(persisted.version, r.scored.version);
    const reasons = db.deriveReasons(
      JSON.parse(persisted.components), JSON.parse(persisted.inputs),
      JSON.parse(persisted.evidence));
    assert.deepEqual([...reasons].sort(), [...r.scored.reasons].sort());
  });
});

describe("single-flight ingestion", () => {
  it("overlapping runs share one execution", async () => {
    ingest.resetIngestFlight();
    let calls = 0;
    const slowProvider = {
      name: "slow-test", kind: "simulated",
      supports: () => true,
      async getQuote(symbol) {
        calls += 1;
        await new Promise((res) => setTimeout(res, 50));
        return {
          symbol, price: 10, volume: 100, asOf: new Date("2026-09-02T10:00:00Z"),
          source: "simulated", prevClose: null, delaySec: null, asOfSource: "provider",
        };
      },
      async getHistory() { return []; },
    };
    const u = db.getOrCreateUser("flight-user");
    const wl = db.ensureDefaultWatchlist(u.id);
    db.addItem(wl.id, "FLIGHT");
    const [a, b] = await Promise.all([
      ingest.runIngestAsync("live", slowProvider),
      ingest.runIngestAsync("live", slowProvider),
    ]);
    assert.equal(calls, a.symbols.length, "one provider hit per symbol in a single shared run");
    assert.equal(b.shared, true);
    assert.deepEqual(a.symbols, b.symbols);
    ingest.resetIngestFlight();
  });
});

describe("normal provider resilience", () => {
  it("rejects missing or zero Finnhub timestamps instead of inventing observation times", async () => {
    const {finnhubProvider}=await import("../smart-watchlist/src/lib/market.ts");
    const originalFetch=globalThis.fetch;const originalKey=process.env.FINNHUB_KEY;
    process.env.FINNHUB_KEY="fixture-key";
    try {
      for(const payload of [{c:100},{c:100,t:0},{c:100,t:-1}]){
        globalThis.fetch=async()=>new Response(JSON.stringify(payload),{status:200});
        await assert.rejects(finnhubProvider.getQuote("AAPL"),/timestamp/);
      }
    } finally {globalThis.fetch=originalFetch;if(originalKey===undefined)delete process.env.FINNHUB_KEY;else process.env.FINNHUB_KEY=originalKey;}
  });
  it("provider failure preserves the real quote and never creates simulated fallback", async () => {
    const u=db.getOrCreateUser("outage");const wl=db.ensureDefaultWatchlist(u.id);db.addItem(wl.id,"OUTAGE");
    const at=new Date().toISOString();db.scoreAndStore("live",{symbol:"OUTAGE",price:123,volume:null,asOf:at,fetchedAt:at,source:"finnhub",prevClose:null,delaySec:null,asOfSource:"provider"});
    await ingest.runIngestAsync("live",{name:"finnhub",kind:"finnhub",supports:()=>true,getQuote:async()=>{throw Error("provider unavailable")},getHistory:async()=>[]});
    assert.equal(db.displayQuote("live","OUTAGE").price,123);assert.equal(db.displayQuote("live","OUTAGE").source,"finnhub");
    assert.equal(db.fetchStatus("live","OUTAGE").outcome,"error");assert.equal(db.recentQuotes("live","OUTAGE",20,"simulated").length,0);
  });
  it("retention preserves the last quote in each source and cleans orphaned scores", () => {
    const old=new Date(Date.now()-10*86400000).toISOString();const older=new Date(Date.now()-11*86400000).toISOString();
    const obs=(asOf,price,source)=>({symbol:"RETAIN",price,volume:null,asOf,fetchedAt:asOf,source,prevClose:null,delaySec:null,asOfSource:"provider"});
    const first=db.scoreAndStore("live",obs(older,100,"finnhub"));db.scoreAndStore("live",obs(old,101,"finnhub"));db.scoreAndStore("live",obs(old,50,"simulated"));
    db.pruneRetention();
    assert.equal(db.displayQuote("live","RETAIN")?.price,101);
    assert.equal(db.latestQuote("live","RETAIN","simulated")?.price,50);
    assert.equal(db.readScore("live","RETAIN",first.quoteId),null);
  });
});

describe("normal watchlist integrity",()=>{
 it("duplicate add stays idempotent at the limit and new membership cannot exceed it",()=>{
  const u=db.getOrCreateUser("limit-case");const w=db.ensureDefaultWatchlist(u.id);
  assert.deepEqual(db.addItem(w.id,"AAPL",undefined,3),{created:false});
  assert.equal(db.addItem(w.id,"MSFT",undefined,3).limitReached,true);
  assert.equal(db.itemsFor(w.id).length,3);
 });
 it("coverage remains incomplete after subsequent no-op pruning",()=>{
  const at=new Date(Date.now()-35*86400000).toISOString();
  db.insertEvent({namespace:"coverage-audit",symbol:"AAPL",score:60,reasons:"[]",summary:"old event",observed_price:100,baseline_price:90,baseline_kind:"previous-observation",components:"{}",source:"simulated",occurred_at:at,fingerprint:"coverage-audit",version:2});
  db.pruneRetention();
  assert.equal(db.coverageFor("unrelated-audit",new Date(Date.now()-40*86400000).toISOString()).incomplete,false);
  db.pruneRetention();
  assert.equal(db.coverageFor("coverage-audit",new Date(Date.now()-40*86400000).toISOString()).incomplete,true);
  assert.equal(db.coverageFor("unrelated-audit",new Date(Date.now()-40*86400000).toISOString()).incomplete,false);
 });
});
