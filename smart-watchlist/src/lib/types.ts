export interface User { id: string; device_token: string; email: string | null; created_at: string }
export interface Watchlist { id: string; user_id: string; name: string; created_at: string }
export interface WatchlistItem { id: string; watchlist_id: string; symbol: string; added_at: string }
export interface QuoteSnapshot {
  id: number; symbol: string; price: number; volume: number | null;
  as_of: string; fetched_at: string; source: string; is_stale: boolean;
  prev_close?: number | null; delay_sec?: number | null; as_of_source?: string;
}
export interface SymbolStats {
  symbol: string; avg_volume_20d: number; return_stddev_20d: number;
  high_52w: number; low_52w: number; updated_at: string;
}
export interface ChangeEvent {
  id: number; symbol: string; score: number; reasons: string[];
  summary: string; occurred_at: string;
}
export interface WatchlistView { watchlist_id: string; user_id: string; last_seen_at: string }
export interface ScoreComp { surprise: number; volume: number; threshold: number; reversal: number }
export interface EnrichedQuote {
  symbol: string; price: number; prevClose: number | null; dayChangePct: number | null;
  dayChangeAbs: number | null; sessionChange: string | null;
  volume: number | null; score: number; reasons: string[]; missing: string[];
  summary: string | null; sparkline: number[]; freshness: string;
  freshnessLabel: string; isStale: boolean; high52w: number | null; low52w: number | null;
  z: number | null; volRatio: number | null; comp: ScoreComp; chips: string[];
  company: string | null; source: string; asOf: string | null;
  sinceReview: { pct: number; baselineAsOf: string } | null;
  quality: { kind: "simulated" | "live" | "delayed" | "stale" | "unavailable"; detail: string };
  version: number; currency: "USD" | "INR";
}
