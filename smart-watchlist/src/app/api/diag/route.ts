import { NextResponse } from "next/server";
import { ctx } from "@/lib/shared";
import { authorizeIngest } from "@/lib/db";
import {
  db, liveSymbols, latestQuote, fetchStatus,
  getMetaValue, migrationStatus, dedupeStatus,
} from "@/lib/db";
import { getProvider } from "@/lib/market";

/**
 * Development-only diagnostics for the data pipeline. Never linked from the
 * product UI. In production it requires the ingestion secret; it never
 * exposes secret values — only whether a key is configured.
 */
export async function GET(req: Request) {
  if (process.env.NODE_ENV === "production" && !authorizeIngest(req)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  await ctx();
  const provider = getProvider();
  const h = db();
  const symbols = liveSymbols();
  const perSymbol = symbols.map((symbol) => {
    const fetch = fetchStatus("live", symbol);
    const latest = latestQuote("live", symbol);
    const counts = h.prepare("SELECT source, COUNT(*) AS n, MAX(as_of) AS mx FROM quotes WHERE namespace = 'live' AND symbol = ? GROUP BY source")
      .all(symbol) as unknown as { source: string; n: number; mx: string }[];
    return {
      symbol,
      configuredProvider: provider.name,
      lastFetchAttempt: fetch?.attemptAt ?? null,
      fetchOutcome: fetch?.outcome ?? null,
      fetchReason: fetch?.reason ?? null,
      providerTimestamp: fetch?.providerAsOf ?? null,
      latestAcceptedAt: latest?.as_of ?? null,
      latestAcceptedSource: latest?.source ?? null,
      countsBySource: counts,
    };
  });
  return NextResponse.json({
    ok: true,
    finnhubKeyConfigured: !!process.env.FINNHUB_KEY,
    provider: provider.name,
    providerKind: provider.kind,
    scheduler: (globalThis as Record<string, unknown>).__sw_scheduler__ ? "running" : "not-started-in-this-process",
    ingestHealth: safeJSON(getMetaValue("ingest_health")),
    liveSource: getMetaValue("live_source"),
    migration: migrationStatus(),
    dedupe: dedupeStatus(),
    perSymbol,
  });
}

function safeJSON(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
