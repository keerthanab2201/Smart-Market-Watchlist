import {
  liveSymbols, setMeta, getMetaValue, scoreAndStore, pruneRetention, recordFetch, LIVE_NS,
} from "./db";
import { getProvider, validateQuote, type MarketDataProvider } from "./market";

export interface IngestResult {
  symbols: string[]; events: number; rejected: number; durationMs: number; at: string;
  shared?: boolean;
}

function nowISO(): string { return new Date().toISOString(); }

function noteRejection(symbol: string, reason: string): void {
  try {
    const raw = getMetaValue("ingest_rejections");
    const arr = raw ? JSON.parse(raw) as { symbol: string; reason: string; at: string }[] : [];
    arr.push({ symbol, reason, at: nowISO() });
    setMeta("ingest_rejections", JSON.stringify(arr.slice(-50)));
  } catch { /* health bookkeeping must never break ingestion */ }
}

export function ingestHealth(): Record<string, unknown> {
  try {
    const raw = getMetaValue("ingest_health");
    if (raw) return JSON.parse(raw) as Record<string, unknown>;
  } catch { /* fall through */ }
  return { status: "never-run" };
}

// Single-flight guard lives on the shared entry point, so the scheduler,
// manual triggers, and overlapping requests all share one run and can never
// duplicate observations or events.
let ingestFlight: Promise<IngestResult> | null = null;

export function runIngestAsync(namespace = LIVE_NS, provider?: MarketDataProvider): Promise<IngestResult> {
  if (ingestFlight) {
    return ingestFlight.then((r) => ({ ...r, shared: true }));
  }
  ingestFlight = runIngestInner(namespace, provider).finally(() => { ingestFlight = null; });
  return ingestFlight;
}

/** Test seam: drop the in-flight guard state between isolated runs. */
export function resetIngestFlight(): void { ingestFlight = null; }

async function runIngestInner(namespace: string, provider?: MarketDataProvider): Promise<IngestResult> {
  const t0 = Date.now();
  const prov = provider ?? getProvider();
  // Never blend simulated and real-provider history: a source switch resets
  // live statistics and is recorded, so windows stay homogeneous.
  if (namespace === LIVE_NS) {
    setMeta("live_source", prov.kind);
  }
  const symbols = namespace === LIVE_NS ? liveSymbols() : [];
  let events = 0;
  let rejected = 0;
  for (const symbol of symbols) {
    // Fetch health is recorded per symbol per attempt, separately from the
    // observation timestamp: a repeated identical session quote is a
    // successful fetch that simply needs no new observation.
    const attemptAt = nowISO();
    try {
      const q = await prov.getQuote(symbol);
      const v = validateQuote(q);
      if (!v.ok) {
        rejected += 1;
        noteRejection(symbol, v.reason);
        recordFetch(namespace, symbol, { attemptAt, provider: prov.kind, outcome: "error", providerAsOf: null, reason: v.reason });
        continue;
      }
      const res = scoreAndStore(namespace, {
        symbol, price: q.price, volume: q.volume,
        asOf: q.asOf.toISOString(), fetchedAt: nowISO(), source: q.source,
        prevClose: q.prevClose, delaySec: q.delaySec,
        asOfSource: q.asOfSource ?? "provider",
      });
      recordFetch(namespace, symbol, {
        attemptAt, provider: prov.kind, httpStatus: q.httpStatus, price: q.price,
        outcome: res.accepted ? "accepted" : res.duplicate ? "duplicate" : "rejected",
        providerAsOf: q.asOf.toISOString(), reason: res.accepted ? null : (res.reason ?? null),
      });
      if (!res.accepted) {
        // Duplicates are idempotent silence; stale timestamps are quarantined.
        if (!res.duplicate) { rejected += 1; noteRejection(symbol, res.reason ?? "rejected"); }
        continue;
      }
      if (res.eventId != null) events += 1;
    } catch (e) {
      noteRejection(symbol, "provider error");
      recordFetch(namespace, symbol, {
        attemptAt, provider: prov.kind, outcome: "error", providerAsOf: null,
        reason: e instanceof Error ? e.message.slice(0, 120) : "provider error",
      });
      rejected += 1;
    }
  }
  pruneRetention();
  const result: IngestResult = { symbols, events, rejected, durationMs: Date.now() - t0, at: nowISO() };
  setMeta("ingest_health", JSON.stringify({ ...result, failures: rejected, lastSuccessAt: rejected === 0 ? result.at : ingestHealth().lastSuccessAt ?? null }));
  return result;
}

// ---- in-process shared scheduler (single-flight, throttled) ----

const SCHED_KEY = "__sw_scheduler__";

export function ensureScheduler(intervalMs = 60_000): void {
  const g = globalThis as Record<string, unknown>;
  if (g[SCHED_KEY]) return;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    runIngestAsync(LIVE_NS).catch(() => {}).finally(() => { running = false; });
  };
  const timer = setInterval(tick, intervalMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  g[SCHED_KEY] = true;
  // Prime the first cycle without blocking boot.
  setTimeout(tick, 2000);
}
