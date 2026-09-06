// HTTP-level ownership + auth checks. Requires a production build first:
//   npm run build && npm run test:http
// Boots `next start` on a temp database, exercises two sessions, then exits.
// Skips (exit 0) if the build output is missing.
import { DatabaseSync } from "node:sqlite";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..", "smart-watchlist");
const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;

if (!existsSync(join(APP, ".next", "BUILD_ID"))) {
  console.log("skip: no production build (run `npm run build` first)");
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "sw-http-"));
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
  cwd: APP,
  env: { ...process.env, SW_DB_PATH: join(dir, "http.sqlite"), PORT: String(PORT), FINNHUB_KEY: "", INGEST_SECRET: "", SW_DISABLE_SCHEDULER: "1" },
  stdio: "pipe",
});

function jar() {
  let cookie = "";
  return {
    header: () => (cookie ? { Cookie: cookie } : {}),
    async fetch(path, opts = {}) {
      const r = await fetch(BASE + path, { ...opts, headers: { ...(opts.headers ?? {}), ...this.header() } });
      const set = r.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      return r;
    },
  };
}

async function waitReady(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}/api/watchlists`);
      if (r.ok) return;
    } catch { /* booting */ }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error("server did not boot");
}

describe("HTTP ownership + ingest auth", () => {
  let a, b, idA;
  before(async () => {
    await waitReady();
    a = jar(); b = jar();
    idA = (await (await a.fetch("/api/watchlists")).json()).defaultWatchlistId;
  });
  after(() => server.kill());

  it("foreign list reads/writes are rejected", async () => {
    assert.equal((await b.fetch(`/api/watchlists/${idA}`)).status, 404);
    assert.equal((await b.fetch(`/api/watchlists/${idA}/changes`)).status, 404);
    assert.equal((await b.fetch(`/api/watchlists/${idA}/items`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol: "AAPL" }),
    })).status, 404);
    assert.equal((await b.fetch(`/api/watchlists/${idA}/mark-seen`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "x" }),
    })).status, 404);
  });


  it("first visit returns watched stocks before tracking begins", async () => {
    const j=await (await a.fetch(`/api/watchlists/${idA}/changes?include=quotes`)).json();
    assert.equal(j.tracking,false); assert.equal(j.quotes.length,3);
  });
  it("remaining owned routes reject a foreign session", async () => {
    assert.equal((await b.fetch(`/api/watchlists/${idA}/items/TSLA`,{method:"DELETE"})).status,404);
    assert.equal((await b.fetch(`/api/watchlists/${idA}/tracking/start`,{method:"POST"})).status,404);
    assert.equal((await b.fetch(`/api/symbols/TSLA/history?watchlistId=${idA}`)).status,404);
    assert.equal((await b.fetch("/api/diag")).status,404);
  });
  it("HTTP tracking and briefing use the displayed source; re-add rejects an old token", async () => {
    const h=new DatabaseSync(join(dir,"http.sqlite"));
    const ins=h.prepare("INSERT INTO quotes(namespace,symbol,price,volume,as_of,fetched_at,source) VALUES ('live','TSLA',?,NULL,?,?,?)");
    ins.run(245.29,"2026-09-05T20:00:00Z","2026-09-06T00:00:00Z","simulated");
    ins.run(354.08,"2026-09-04T20:00:00Z","2026-09-06T00:00:00Z","finnhub");
    assert.equal((await a.fetch(`/api/watchlists/${idA}/tracking/start`,{method:"POST"})).status,200);
    const snap=await (await a.fetch(`/api/watchlists/${idA}/changes?include=quotes`)).json();
    assert.equal(snap.baselines.TSLA.price,354.08);assert.equal(snap.baselines.TSLA.source,"finnhub");
    assert.equal(snap.quotes.find(q=>q.symbol==="TSLA").sinceReview.pct,0);
    const hist=await (await a.fetch(`/api/symbols/TSLA/history?watchlistId=${idA}`)).json();
    assert.equal(hist.samples.length,1);assert.equal(hist.samples[0].source,"finnhub");assert.equal(hist.samples[0].volume,null);
    const old=h.prepare("SELECT id FROM items WHERE watchlist_id=? AND symbol='TSLA'").get(idA).id;
    await a.fetch(`/api/watchlists/${idA}/items/TSLA`,{method:"DELETE"});
    await a.fetch(`/api/watchlists/${idA}/items`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({symbol:"TSLA"})});
    assert.notEqual(h.prepare("SELECT id FROM items WHERE watchlist_id=? AND symbol='TSLA'").get(idA).id,old);
    await a.fetch(`/api/watchlists/${idA}/mark-seen`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:snap.reviewToken})});
    assert.equal(h.prepare("SELECT COUNT(*) n FROM item_baselines WHERE watchlist_id=? AND symbol='TSLA'").get(idA).n,0);
    assert.equal(h.prepare("SELECT COUNT(*) n FROM quotes WHERE symbol='TSLA'").get().n,2);h.close();
  });
  it("ingest POST requires the secret", async () => {
    // No INGEST_SECRET configured here → every external POST is rejected.
    assert.equal((await a.fetch("/api/ingest", { method: "POST" })).status, 401);
    const health = await (await a.fetch("/api/ingest")).json();
    assert.equal(health.ok, true, "health GET stays observational");
  });
});
