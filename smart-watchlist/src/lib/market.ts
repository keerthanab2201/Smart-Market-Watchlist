export interface Quote {
  symbol: string;
  price: number;
  /** Null when the provider does not report volume (e.g. Finnhub /quote). */
  volume: number | null;
  asOf: Date;
  /** 'simulated' | 'finnhub' — never presented as live unless the source says so. */
  source: "simulated" | "finnhub";
  /** Previous completed session close. Null when the source has no session data. */
  prevClose: number | null;
  /** Declared delay in seconds, when known. */
  delaySec: number | null;
  /**
   * 'provider' when asOf came from the provider, 'fetch' when the provider
   * gave no timestamp and fetch time was used instead (never silent).
   */
  asOfSource: "provider" | "fetch";
}

export interface MarketDataProvider {
  name: string;
  kind: Quote["source"];
  getQuote(symbol: string): Promise<Quote>;
  getHistory(symbol: string, days: number): Promise<number[]>;
  supports(symbol: string): boolean;
}

const BASE: Record<string, { price: number; vol: number }> = {
  AAPL: { price: 232.5, vol: 52_000_000 }, NVDA: { price: 131.2, vol: 240_000_000 },
  TSLA: { price: 248.9, vol: 98_000_000 }, MSFT: { price: 428.1, vol: 21_000_000 },
  AMZN: { price: 197.4, vol: 38_000_000 }, META: { price: 585.3, vol: 12_000_000 },
  GOOGL: { price: 176.8, vol: 24_000_000 }, AMD: { price: 122.6, vol: 45_000_000 },
  RELIANCE: { price: 2985.0, vol: 4_200_000 }, TCS: { price: 4210.5, vol: 1_800_000 },
  INFY: { price: 1865.2, vol: 6_500_000 }, HDFCBANK: { price: 1642.8, vol: 9_000_000 },
};

const drift: Record<string, number> = {};

export const VALID_SYMBOLS = new Set([...Object.keys(BASE), "NFLX", "COIN", "PLTR", "GME", "AMC", "NIFTYBEES", "SBIN"]);

function extended(sym: string): { price: number; vol: number } {
  if (BASE[sym]) return BASE[sym];
  let h = 0;
  for (const c of sym) h = (h * 31 + c.charCodeAt(0)) % 997;
  return { price: 50 + h * 1.7, vol: 5_000_000 + h * 50_000 };
}

/** Zero-key simulation provider. Output is explicitly labelled simulated. */
export const simulationProvider: MarketDataProvider = {
  name: "simulation",
  kind: "simulated",
  supports: (s) => VALID_SYMBOLS.has(s.toUpperCase()),
  async getQuote(symbol: string): Promise<Quote> {
    const sym = symbol.toUpperCase();
    const { price, vol } = extended(sym);
    const d = drift[sym] ?? 0;
    const shock = (Math.random() - 0.5) * 0.04;
    const spike = Math.random() < 0.06 ? (Math.random() - 0.35) * 0.09 : 0;
    const next = Math.max(price * 0.5, price * (1 + d * 0.02) + price * (shock + spike));
    drift[sym] = d * 0.92 + shock * 4;
    const volMult = 0.6 + Math.random() * 1.2 + Math.abs(spike) * 22;
    return { symbol: sym, price: round2(next), volume: Math.round(vol * volMult), asOf: new Date(), source: "simulated", prevClose: null, delaySec: null, asOfSource: "provider" };
  },
  async getHistory(symbol: string, days: number): Promise<number[]> {
    const sym = symbol.toUpperCase();
    const { price } = extended(sym);
    const out: number[] = [];
    let p = price * (1 - drift[sym] * 0.01 || 1 * 0);
    for (let i = 0; i < days; i++) {
      p = p * (1 + (Math.random() - 0.5) * 0.03);
      out.push(round2(p));
    }
    out.push(round2(price));
    return out.slice(-days);
  },
};

function round2(n: number): number { return Math.round(n * 100) / 100; }

/**
 * Finnhub adapter (requires FINNHUB_KEY). Implemented against the public
 * /quote schema; live integration NOT verified in this environment — see README.
 * /quote carries no volume, so volume is honestly reported as unknown.
 */
export const finnhubProvider: MarketDataProvider = {
  name: "finnhub",
  kind: "finnhub",
  supports: () => true,
  async getQuote(symbol: string): Promise<Quote> {
    const key = process.env.FINNHUB_KEY;
    if (!key) throw new Error("FINNHUB_KEY is not configured");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`, { signal: ctrl.signal });
      if (res.status === 429) throw new Error("finnhub rate limited");
      if (!res.ok) throw new Error(`finnhub HTTP ${res.status}`);
      const j = await res.json() as { c?: number; pc?: number; t?: number };
      const px = j.c;
      if (!(typeof px === "number" && px > 0)) throw new Error("finnhub returned no price");
      const hasT = typeof j.t === "number";
      return {
        symbol: symbol.toUpperCase(), price: px, volume: null,
        asOf: hasT ? new Date((j.t as number) * 1000) : new Date(),
        source: "finnhub", prevClose: typeof j.pc === "number" && j.pc > 0 ? j.pc : null, delaySec: 60,
        asOfSource: hasT ? "provider" : "fetch",
      };
    } finally {
      clearTimeout(timer);
    }
  },
  async getHistory(): Promise<number[]> { return []; },
};

export function getProvider(): MarketDataProvider {
  return process.env.FINNHUB_KEY ? finnhubProvider : simulationProvider;
}

/** Reject invalid payloads before they can corrupt state. Future-dated quotes are quarantined. */
export function validateQuote(q: Quote): { ok: true } | { ok: false; reason: string } {
  if (!Number.isFinite(q.price) || q.price <= 0) return { ok: false, reason: "non-positive price" };
  if (q.volume != null && (!Number.isFinite(q.volume) || q.volume < 0)) return { ok: false, reason: "invalid volume" };
  const t = q.asOf.getTime();
  if (!Number.isFinite(t)) return { ok: false, reason: "invalid timestamp" };
  if (t > Date.now() + 5 * 60_000) return { ok: false, reason: "future-dated quote quarantined" };
  if (q.prevClose != null && !(q.prevClose > 0)) return { ok: false, reason: "invalid previous close" };
  return { ok: true };
}

export function normalizeSymbol(s: string): string { return s.trim().toUpperCase().replace(/[^A-Z0-9.=-]/g, ""); }
