import { NextResponse } from "next/server";
import {
  db, tx, uid, nowISO, getOrCreateUser, ensureDefaultWatchlist, getOwnedWatchlist,
  displayQuote, recentQuotes, readBaseline, readScore, deriveReasons, fetchStatus,
} from "@/lib/db";
import { scoreQuote, buildSummary, THRESHOLD, SCORE_VERSION, type ScoredResult } from "@/lib/score";
import { normalizeSymbol, VALID_SYMBOLS } from "@/lib/market";
import { deviceToken, setDeviceCookie, isMarketOpen } from "@/lib/session";
import { companyName, currencyFor } from "@/lib/companies";
import { fmtSessionChange, describeQuoteStatus, timeAgo } from "@/lib/format";
import type { EnrichedQuote, Watchlist } from "@/lib/types";

export async function ctx() {
  const token = await deviceToken();
  const user = getOrCreateUser(token);
  await setDeviceCookie(token);
  const watchlist = ensureDefaultWatchlist(user.id);
  return { user, watchlist };
}

type Owned = Watchlist & { is_demo: number };

export function requireWatchlist(userId: string, id: string): Owned | null {
  if (!id) return null;
  return getOwnedWatchlist(userId, id);
}

export function notFound() {
  return NextResponse.json({ error: "Watchlist not found" }, { status: 404 });
}

/** Approximate US-market schedule. Holidays and early closes are NOT modeled. */
export function marketState(now = new Date()): { open: boolean; label: string; note: string; etNow: string } {
  const open = isMarketOpen(now);
  let etNow = "";
  try {
    etNow = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", weekday: "short",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(now);
  } catch {
    etNow = "";
  }
  return {
    open,
    label: open ? "US market open" : "US market closed",
    note: "Weekday 9:30–16:00 ET approximation; holidays and early closes are not modeled.",
    etNow: etNow ? `${etNow} ET` : "",
  };
}

const EMPTY_COMP = { surprise: 0, volume: 0, threshold: 0, reversal: 0 };

export function qualityFor(source: string, asOf: string | null, marketOpen: boolean): EnrichedQuote["quality"] {
  return describeQuoteStatus(asOf, source, marketOpen);
}

export type { Observation, StoreResult } from "@/lib/db";
export { scoreAndStore } from "@/lib/db";

export { authorizeIngest, deriveReasons } from "@/lib/db";


export function enrich(symbols: string[], namespace: string, watchlistId: string, userId: string): EnrichedQuote[] {
  const marketOpen = isMarketOpen();
  const h = db();
  return symbols.map((symbol): EnrichedQuote => {
    // Display prefers the real-provider stream: a valid earlier-dated
    // session quote supersedes newer simulated rows. Simulated history is
    // preserved but never shown once real data exists, and never restored
    // silently after a provider failure.
    const last = displayQuote(namespace, symbol);
    // History follows the displayed quote's source: simulated and
    // real-provider observations are never blended into one window.
    const hist = last ? recentQuotes(namespace, symbol, 8, last.source) : [];
    const closes = hist.map((x) => Number(x.price));
    const prev = hist.length >= 2 ? hist[hist.length - 2] : undefined;
    const base = readBaseline(namespace, symbol);
    const price = last ? Number(last.price) : 0;
    const prevPrice = prev ? Number(prev.price) : null;
    const volume = last?.volume ?? null;

    // Display the persisted score stored with this exact quote. Only rows
    // that predate persisted scoring fall back to a live computation.
    const persisted = last ? readScore(namespace, symbol, last.id) : null;
    let scored: ScoredResult | null = null;
    if (persisted) {
      const ev = JSON.parse(persisted.evidence) as { price: number; rangeHi: number | null; rangeLo: number | null };
      const comp = JSON.parse(persisted.components) as ScoredResult["components"];
      const inputs = JSON.parse(persisted.inputs) as ScoredResult["inputs"];
      scored = {
        total: persisted.score, components: comp, reasons: deriveReasons(comp, inputs, ev),
        missing: JSON.parse(persisted.missing) as string[],
        version: persisted.version, inputs,
      };
    } else if (last) {
      scored = scoreQuote({
        price, prevPrice, volume: volume ?? 0,
        nRet: base.n_ret, stdRet: base.std_ret, nVol: base.n_vol, avgVol: base.avg_vol,
        rangeHi: base.range_hi, rangeLo: base.range_lo, rangeN: base.range_n, closes,
      });
    }
    const score = scored?.total ?? 0;
    const reasons = scored?.reasons ?? [];
    const missing = scored?.missing ?? ["baseline"];
    const ret = prevPrice ? (price - prevPrice) / prevPrice : null;
    const summary = scored && score >= THRESHOLD && ret != null
      ? buildSummary(ret, scored.inputs.volRatio, reasons) : null;

    const chips: string[] = [];
    if (scored?.inputs.z != null && scored.inputs.z >= 1.5) chips.push(`${scored.inputs.z.toFixed(1)}× typical move`);
    if (scored?.inputs.volRatio != null && scored.inputs.volRatio >= 1.3) chips.push(`${scored.inputs.volRatio.toFixed(1)}× recent-sample avg volume`);
    if (reasons.includes("range_high")) chips.push("new observed high");
    if (reasons.includes("range_low")) chips.push("new observed low");
    if (reasons.includes("trend_reversal")) chips.push("trend reversal");

    const baseline = h.prepare("SELECT price, as_of FROM item_baselines WHERE watchlist_id = ? AND user_id = ? AND symbol = ?")
      .get(watchlistId, userId, symbol) as { price: number; as_of: string } | undefined;
    const sinceReview = baseline && baseline.price > 0 && price > 0
      ? { pct: ((price - baseline.price) / baseline.price) * 100, baselineAsOf: baseline.as_of } : null;

    // Session change uses the provider's previous close when preserved on the
    // quote; otherwise it stays unavailable rather than fabricated.
    const sessionChange = fmtSessionChange(last?.prev_close ?? null, price);

    const quality = qualityFor(last?.source ?? "", last?.as_of ?? null, marketOpen);
    const fetch = fetchStatus(namespace, symbol);
    if (last && last.source === "simulated" && fetch?.provider === "finnhub" && fetch.outcome === "error") {
      quality.detail = `Previous simulated data · Finnhub update failed (${timeAgo(fetch.attemptAt)})`;
    }
    const fetchHealth = fetch
      ? { attemptAt: fetch.attemptAt, outcome: fetch.outcome, providerAsOf: fetch.providerAsOf, reason: fetch.reason }
      : null;
    return {
      symbol, price, prevClose: prevPrice,
      dayChangePct: ret != null ? ret * 100 : null,
      dayChangeAbs: ret != null && prevPrice != null ? price - prevPrice : null,
      sessionChange, volume, score, reasons, missing, summary,
      sparkline: closes.slice(-8), freshness: quality.kind, freshnessLabel: quality.detail,
      isStale: quality.kind === "stale",
      high52w: base.range_hi, low52w: base.range_lo,
      z: scored?.inputs.z != null ? Math.round(scored.inputs.z * 10) / 10 : null,
      volRatio: scored?.inputs.volRatio != null ? Math.round(scored.inputs.volRatio * 10) / 10 : null,
      comp: scored ? {
        surprise: Math.round(scored.components.surprise), volume: Math.round(scored.components.volume),
        threshold: Math.round(scored.components.range), reversal: Math.round(scored.components.reversal),
      } : EMPTY_COMP,
      chips: chips.slice(0, 3),
      company: companyName(symbol), source: last?.source ?? "unknown", asOf: last?.as_of ?? null,
      sinceReview, quality, version: SCORE_VERSION, currency: currencyFor(symbol),
      fetch: fetchHealth,
    };
  });
}

export type { IngestResult } from "@/lib/ingest";
export { runIngestAsync, ingestHealth, ensureScheduler, resetIngestFlight } from "@/lib/ingest";

export { THRESHOLD, normalizeSymbol, VALID_SYMBOLS, tx, uid, nowISO };
export { NextResponse };
