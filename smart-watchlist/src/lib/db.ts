import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync, readFileSync, renameSync, existsSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { User, Watchlist, WatchlistItem, QuoteSnapshot, ChangeEvent } from "./types";
import { scoreQuote, buildSummary, eventFingerprint, THRESHOLD, SCORE_VERSION, type ScoredResult } from "./score";

const DATA_DIR = process.env.SW_DATA_DIR || path.join(process.cwd(), ".data");
export const DB_PATH = process.env.SW_DB_PATH || path.join(DATA_DIR, "watchlist.sqlite");
const LEGACY_PATH = path.join(DATA_DIR, "db.json");

export const LIVE_NS = "live";
export const demoNs = (userId: string): string => `demo:${userId}`;

export function uid(): string { return randomUUID(); }
export function nowISO(): string { return new Date().toISOString(); }

/** True only with a configured secret presented correctly. No Next.js dependency. */
export function authorizeIngest(req: Request): boolean {
  const secret = process.env.INGEST_SECRET;
  if (!secret) return false;
  return req.headers.get("x-ingest-secret") === secret;
}

/** Rebuild reason codes from persisted components + evidence (deterministic). */
export function deriveReasons(
  comp: { surprise: number; volume: number; reversal: number; threshold?: number; range?: number },
  inputs: { z: number | null; volRatio: number | null },
  ev: { price: number; rangeHi: number | null; rangeLo: number | null },
): string[] {
  const r: string[] = [];
  const rangePts = comp.threshold ?? comp.range ?? 0;
  if (comp.surprise > 0 && (inputs.z ?? 0) >= 2) r.push("sized_move");
  if (comp.volume > 0 && (inputs.volRatio ?? 0) >= 1.8) r.push("volume_surge");
  if (rangePts > 0) {
    r.push(ev.rangeHi != null && ev.price >= ev.rangeHi ? "range_high" : "range_low");
  }
  if (comp.reversal > 0) r.push("trend_reversal");
  return r;
}

let handle: DatabaseSync | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, device_token TEXT UNIQUE NOT NULL,
  email TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS watchlists (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_watchlists_user ON watchlists(user_id);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, watchlist_id TEXT NOT NULL, symbol TEXT NOT NULL,
  added_at TEXT NOT NULL, UNIQUE(watchlist_id, symbol)
);
CREATE INDEX IF NOT EXISTS idx_items_wl ON items(watchlist_id);
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL DEFAULT 'live',
  symbol TEXT NOT NULL, price REAL NOT NULL, volume REAL,
  as_of TEXT NOT NULL, fetched_at TEXT NOT NULL, source TEXT NOT NULL,
  prev_close REAL, delay_sec INTEGER, as_of_source TEXT NOT NULL DEFAULT 'provider'
);
CREATE INDEX IF NOT EXISTS idx_quotes_ns_sym ON quotes(namespace, symbol, as_of);
CREATE TABLE IF NOT EXISTS quote_scores (
  namespace TEXT NOT NULL, symbol TEXT NOT NULL, quote_id INTEGER NOT NULL,
  score REAL NOT NULL, components TEXT NOT NULL, missing TEXT NOT NULL,
  version INTEGER NOT NULL, inputs TEXT NOT NULL, evidence TEXT NOT NULL,
  PRIMARY KEY (namespace, symbol, quote_id)
);
CREATE TABLE IF NOT EXISTS symbol_samples (
  namespace TEXT NOT NULL DEFAULT 'live', symbol TEXT NOT NULL,
  n_ret INTEGER NOT NULL DEFAULT 0,
  mean_ret REAL NOT NULL DEFAULT 0, m2_ret REAL NOT NULL DEFAULT 0,
  n_vol INTEGER NOT NULL DEFAULT 0, avg_vol REAL NOT NULL DEFAULT 0,
  range_hi REAL, range_lo REAL, range_n INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT,
  updated_at TEXT NOT NULL, PRIMARY KEY (namespace, symbol)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL DEFAULT 'live',
  symbol TEXT NOT NULL, score REAL NOT NULL, reasons TEXT NOT NULL,
  summary TEXT NOT NULL, observed_price REAL NOT NULL, baseline_price REAL,
  baseline_kind TEXT, components TEXT NOT NULL, source TEXT NOT NULL,
  occurred_at TEXT NOT NULL, fingerprint TEXT NOT NULL, version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ns ON events(namespace, symbol, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_fp ON events(namespace, fingerprint, occurred_at);
CREATE TABLE IF NOT EXISTS reviews (
  watchlist_id TEXT NOT NULL, user_id TEXT NOT NULL,
  tracking_since TEXT NOT NULL, reviewed_at TEXT,
  PRIMARY KEY (watchlist_id, user_id)
);
CREATE TABLE IF NOT EXISTS reviewed_events (
  watchlist_id TEXT NOT NULL, user_id TEXT NOT NULL, event_id INTEGER NOT NULL,
  reviewed_at TEXT NOT NULL, PRIMARY KEY (watchlist_id, user_id, event_id)
);
CREATE TABLE IF NOT EXISTS item_baselines (
  watchlist_id TEXT NOT NULL, user_id TEXT NOT NULL, symbol TEXT NOT NULL,
  price REAL NOT NULL, quote_id INTEGER, as_of TEXT NOT NULL,
  PRIMARY KEY (watchlist_id, user_id, symbol)
);
CREATE TABLE IF NOT EXISTS briefing_snapshots (
  token TEXT PRIMARY KEY, watchlist_id TEXT NOT NULL, user_id TEXT NOT NULL,
  event_ids TEXT NOT NULL, baselines TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export function db(): DatabaseSync {
  if (handle) return handle;
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  handle = new DatabaseSync(DB_PATH);
  handle.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  handle.exec(SCHEMA);
  migrateSchema(handle);
  migrateLegacySync(handle);
  return handle;
}

/** Run fn inside an IMMEDIATE transaction. Errors propagate to callers. */
export function tx<T>(fn: (h: DatabaseSync) => T): T {
  const h = db();
  h.exec("BEGIN IMMEDIATE");
  try {
    const out = fn(h);
    h.exec("COMMIT");
    return out;
  } catch (e) {
    try { h.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}

function getMeta(h: DatabaseSync, key: string): string | null {
  const row = h.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setMetaOn(h: DatabaseSync, key: string, value: string): void {
  h.prepare("INSERT INTO meta(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

function migrationState(h: DatabaseSync): { status: string } | null {
  try {
    const raw = getMeta(h, "legacy_migration");
    return raw ? (JSON.parse(raw) as { status: string }) : null;
  } catch {
    return null;
  }
}

/** v1 → v2 upgrades for databases created before the new columns existed. */
function migrateSchema(h: DatabaseSync): void {
  const cols = new Set(
    (h.prepare("PRAGMA table_info(quotes)").all() as unknown as { name: string; notnull: number }[])
      .map((c) => c.name)
  );
  if (!cols.has("prev_close")) {
    const vol = (h.prepare("PRAGMA table_info(quotes)").all() as unknown as { name: string; notnull: number }[])
      .find((c) => c.name === "volume");
    if (vol && vol.notnull === 1) {
      // Nullability can't be altered in place: rebuild once, preserving rows.
      h.exec(`CREATE TABLE quotes_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL DEFAULT 'live',
        symbol TEXT NOT NULL, price REAL NOT NULL, volume REAL,
        as_of TEXT NOT NULL, fetched_at TEXT NOT NULL, source TEXT NOT NULL,
        prev_close REAL, delay_sec INTEGER, as_of_source TEXT NOT NULL DEFAULT 'provider'
      )`);
      h.exec(`INSERT INTO quotes_v2 (id, namespace, symbol, price, volume, as_of, fetched_at, source, prev_close, delay_sec, as_of_source)
        SELECT id, namespace, symbol, price, volume, as_of, fetched_at, source, NULL, NULL, 'provider' FROM quotes`);
      h.exec("DROP TABLE quotes");
      h.exec("ALTER TABLE quotes_v2 RENAME TO quotes");
      h.exec("CREATE INDEX IF NOT EXISTS idx_quotes_ns_sym ON quotes(namespace, symbol, as_of)");
    } else {
      h.exec("ALTER TABLE quotes ADD COLUMN prev_close REAL");
      h.exec("ALTER TABLE quotes ADD COLUMN delay_sec INTEGER");
      h.exec("ALTER TABLE quotes ADD COLUMN as_of_source TEXT NOT NULL DEFAULT 'provider'");
    }
  }
  const icols = new Set((h.prepare("PRAGMA table_info(items)").all() as {name:string}[]).map(c=>c.name));
  if (!icols.has("event_floor")) h.exec("ALTER TABLE items ADD COLUMN event_floor INTEGER NOT NULL DEFAULT 0");
  const bcols = new Set((h.prepare("PRAGMA table_info(item_baselines)").all() as { name: string }[]).map(c => c.name));
  if (!bcols.has("source")) {
    h.exec("ALTER TABLE item_baselines ADD COLUMN source TEXT; ALTER TABLE item_baselines ADD COLUMN membership_id TEXT;");
    h.exec(`UPDATE item_baselines SET source = (SELECT source FROM quotes WHERE id = item_baselines.quote_id),
      membership_id = (SELECT id FROM items WHERE watchlist_id = item_baselines.watchlist_id AND symbol = item_baselines.symbol)`);
  }
  const scol = new Set(
    (h.prepare("PRAGMA table_info(symbol_samples)").all() as unknown as { name: string }[]).map((c) => c.name)
  );
  if (!scol.has("first_seen")) h.exec("ALTER TABLE symbol_samples ADD COLUMN first_seen TEXT");
}

/**
 * One-shot legacy JSON import. Runs synchronously inside db() so no request
 * can observe a half-migrated database. Success is recorded only after the
 * import transaction commits; failures are recorded with the cause, the
 * source file is preserved, and retryLegacyMigration() can re-run it.
 */
function migrateLegacySync(h: DatabaseSync): void {
  if (migrationState(h)?.status === "ok") return;
  let raw: string;
  try {
    raw = readFileSync(LEGACY_PATH, "utf8");
  } catch {
    setMetaOn(h, "legacy_migration", JSON.stringify({ status: "absent", at: nowISO() }));
    return;
  }
  let legacy: Record<string, unknown>;
  try {
    legacy = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    const bak = `${LEGACY_PATH}.corrupt-${Date.now()}.bak`;
    try { renameSync(LEGACY_PATH, bak); } catch { /* keep original */ }
    setMetaOn(h, "legacy_migration", JSON.stringify({ status: "failed", error: `unparseable JSON: ${e}`, backup: bak, at: nowISO() }));
    return;
  }
  try {
    h.exec("BEGIN IMMEDIATE");
    const users = (legacy.users ?? []) as User[];
    const lists = (legacy.watchlists ?? []) as Watchlist[];
    const items = (legacy.items ?? []) as WatchlistItem[];
    const snaps = (legacy.snapshots ?? []) as QuoteSnapshot[];
    const events = (legacy.events ?? []) as ChangeEvent[];
    const views = (legacy.views ?? []) as { watchlist_id: string; user_id: string; last_seen_at: string }[];
    const iu = h.prepare("INSERT OR IGNORE INTO users(id, device_token, email, created_at) VALUES (?,?,?,?)");
    for (const u of users) iu.run(u.id, u.device_token, u.email, u.created_at);
    const iw = h.prepare("INSERT OR IGNORE INTO watchlists(id, user_id, name, is_demo, created_at) VALUES (?,?,?,?,?)");
    for (const w of lists) iw.run(w.id, w.user_id, w.name, 0, w.created_at);
    const ii = h.prepare("INSERT OR IGNORE INTO items(id, watchlist_id, symbol, added_at) VALUES (?,?,?,?)");
    for (const i of items) ii.run(i.id, i.watchlist_id, i.symbol, i.added_at);
    const iq = h.prepare("INSERT INTO quotes(namespace, symbol, price, volume, as_of, fetched_at, source, prev_close, delay_sec, as_of_source) VALUES ('live',?,?,?,?,?,?,NULL,NULL,'provider')");
    for (const s of snaps.slice(-2000)) iq.run(s.symbol, s.price, s.volume, s.as_of, s.fetched_at, s.source);
    const ie = h.prepare(
      "INSERT INTO events(namespace, symbol, score, reasons, summary, observed_price, baseline_price, baseline_kind, components, source, occurred_at, fingerprint, version) VALUES ('live',?,?,?,?,?,?,?,?,?,?,?,1)"
    );
    for (const e of events.slice(-200)) {
      ie.run(e.symbol, e.score, JSON.stringify(e.reasons), e.summary, 0, null, null,
        JSON.stringify({}), "legacy", e.occurred_at, `legacy:${e.id}`, 1);
    }
    const ir = h.prepare("INSERT OR IGNORE INTO reviews(watchlist_id, user_id, tracking_since, reviewed_at) VALUES (?,?,?,?)");
    for (const v of views) ir.run(v.watchlist_id, v.user_id, v.last_seen_at, v.last_seen_at);
    h.exec("COMMIT");
    try { renameSync(LEGACY_PATH, `${LEGACY_PATH}.bak`); } catch { /* backup optional */ }
    setMetaOn(h, "legacy_migration", JSON.stringify({ status: "ok", at: nowISO() }));
  } catch (e) {
    try { h.exec("ROLLBACK"); } catch { /* already rolled back */ }
    setMetaOn(h, "legacy_migration", JSON.stringify({ status: "failed", error: String(e), at: nowISO() }));
  }
}

/** Documented retry after a failed legacy import. Throws if nothing is pending. */
export function retryLegacyMigration(): Record<string, unknown> {
  const h = db();
  if (migrationState(h)?.status === "ok") return { status: "ok", note: "already migrated" };
  if (!existsSync(LEGACY_PATH)) throw new Error("no legacy db.json present to retry");
  migrateLegacySync(h);
  return JSON.parse(getMeta(h, "legacy_migration") ?? '{"status":"unknown"}') as Record<string, unknown>;
}

export function migrationStatus(): Record<string, unknown> {
  const raw = getMeta(db(), "legacy_migration");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : { status: "unknown" };
}

// ---- users / watchlists ----

export function getOrCreateUser(deviceToken: string): User {
  return tx((h) => {
    const found = h.prepare("SELECT * FROM users WHERE device_token = ?").get(deviceToken) as User | undefined;
    if (found) return found;
    const u: User = { id: uid(), device_token: deviceToken, email: null, created_at: nowISO() };
    h.prepare("INSERT INTO users(id, device_token, email, created_at) VALUES (?,?,?,?)")
      .run(u.id, u.device_token, u.email, u.created_at);
    return u;
  });
}

export function ensureDefaultWatchlist(userId: string): Watchlist {
  return tx((h) => {
    const found = h.prepare("SELECT * FROM watchlists WHERE user_id = ? AND is_demo = 0 ORDER BY created_at LIMIT 1")
      .get(userId) as Watchlist | undefined;
    if (found) return found;
    const now = nowISO();
    const w: Watchlist = { id: uid(), user_id: userId, name: "My Watchlist", created_at: now };
    h.prepare("INSERT INTO watchlists(id, user_id, name, is_demo, created_at) VALUES (?,?,?,?,?)")
      .run(w.id, userId, w.name, 0, now);
    const ii = h.prepare("INSERT OR IGNORE INTO items(id, watchlist_id, symbol, added_at) VALUES (?,?,?,?)");
    for (const sym of ["AAPL", "NVDA", "TSLA"]) ii.run(uid(), w.id, sym, now);
    return w;
  });
}

export function getOwnedWatchlist(userId: string, id: string): (Watchlist & { is_demo: number }) | null {
  const row = db().prepare("SELECT * FROM watchlists WHERE id = ? AND user_id = ?").get(id, userId) as
    (Watchlist & { is_demo: number }) | undefined;
  return row ?? null;
}

export function getDemoWatchlist(userId: string): Watchlist & { is_demo: number } {
  return tx((h) => {
    const found = h.prepare("SELECT * FROM watchlists WHERE user_id = ? AND is_demo = 1 ORDER BY created_at LIMIT 1")
      .get(userId) as (Watchlist & { is_demo: number }) | undefined;
    if (found) return found;
    const w = { id: uid(), user_id: userId, name: "Demo · Simulated", created_at: nowISO(), is_demo: 1 };
    h.prepare("INSERT INTO watchlists(id, user_id, name, is_demo, created_at) VALUES (?,?,?,?,?)")
      .run(w.id, userId, w.name, 1, w.created_at);
    return w;
  });
}

export function itemsFor(watchlistId: string): WatchlistItem[] {
  return db().prepare("SELECT * FROM items WHERE watchlist_id = ? ORDER BY added_at").all(watchlistId) as unknown as WatchlistItem[];
}

export function itemAddedAt(watchlistId: string, symbol: string): string | null {
  const row = db().prepare("SELECT added_at FROM items WHERE watchlist_id = ? AND symbol = ?")
    .get(watchlistId, symbol) as { added_at: string } | undefined;
  return row?.added_at ?? null;
}

/** INSERT OR IGNORE — returns true when a new row was created. Safe under concurrency. */
export function addItem(watchlistId: string, symbol: string, at = nowISO()): { created: boolean } {
  const r = db().prepare("INSERT OR IGNORE INTO items(id, watchlist_id, symbol, added_at, event_floor) VALUES (?,?,?,?,(SELECT COALESCE(MAX(id),0) FROM events))")
    .run(uid(), watchlistId, symbol, at);
  return { created: Number(r.changes) === 1 };
}

export function removeItem(watchlistId: string, userId: string, symbol: string): boolean {
  return tx((h) => {
    const r = h.prepare("DELETE FROM items WHERE watchlist_id = ? AND symbol = ?").run(watchlistId, symbol);
    // Membership ended: drop this period's review baseline so a later re-add
    // starts fresh and old briefing tokens cannot restore it (see ackSnapshot).
    h.prepare("DELETE FROM item_baselines WHERE watchlist_id = ? AND user_id = ? AND symbol = ?")
      .run(watchlistId, userId, symbol);
    return Number(r.changes) > 0;
  });
}

// ---- quotes ----

/** Symbols needing live ingestion: items in real watchlists + live-quoted symbols. */
export function liveSymbols(): string[] {
  const rows = db().prepare(
    `SELECT DISTINCT symbol FROM items i JOIN watchlists w ON w.id = i.watchlist_id WHERE w.is_demo = 0`
  ).all() as unknown as { symbol: string }[];
  return rows.map((r) => r.symbol);
}

/** Symbols in demo namespaces (for status only; demos refresh on demand). */
export function demoSymbols(namespace: string): string[] {
  const rows = db().prepare("SELECT DISTINCT symbol FROM quotes WHERE namespace = ?").all(namespace) as unknown as { symbol: string }[];
  return rows.map((r) => r.symbol);
}

export function latestQuote(namespace: string, symbol: string, source?: string): QuoteSnapshot | undefined {
  return source == null
    ? db().prepare("SELECT * FROM quotes WHERE namespace = ? AND symbol = ? ORDER BY as_of DESC, id DESC LIMIT 1")
      .get(namespace, symbol) as QuoteSnapshot | undefined
    : db().prepare("SELECT * FROM quotes WHERE namespace = ? AND symbol = ? AND source = ? ORDER BY as_of DESC, id DESC LIMIT 1")
      .get(namespace, symbol, source) as QuoteSnapshot | undefined;
}

/**
 * Display preference: a real-provider observation supersedes simulated ones
 * even when its timestamp is earlier. Simulated history is preserved, just
 * not shown once real data exists. Never falls back silently: the choice is
 * deterministic from stored provenance.
 */
export function displayQuote(namespace: string, symbol: string): QuoteSnapshot | undefined {
  return latestQuote(namespace, symbol, "finnhub") ?? latestQuote(namespace, symbol);
}

export function displaySource(namespace: string, symbol: string): string {
  return displayQuote(namespace, symbol)?.source ?? "unknown";
}

export function hasSourceHistory(namespace: string, symbol: string, source: string): boolean {
  const row = db().prepare("SELECT 1 AS x FROM quotes WHERE namespace = ? AND symbol = ? AND source = ? LIMIT 1")
    .get(namespace, symbol, source) as { x: number } | undefined;
  return !!row;
}

export function recentQuotes(namespace: string, symbol: string, n: number, source?: string): QuoteSnapshot[] {
  const rows = source == null
    ? db().prepare("SELECT * FROM quotes WHERE namespace = ? AND symbol = ? ORDER BY as_of DESC, id DESC LIMIT ?").all(namespace, symbol, n)
    : db().prepare("SELECT * FROM quotes WHERE namespace = ? AND symbol = ? AND source = ? ORDER BY as_of DESC, id DESC LIMIT ?").all(namespace, symbol, source, n);
  return (rows as unknown as QuoteSnapshot[]).reverse();
}

export interface NewQuote {
  symbol: string; price: number; volume: number | null;
  as_of: string; fetched_at: string; source: string;
  prev_close: number | null; delay_sec: number | null; as_of_source: string;
}

export function insertQuote(namespace: string, q: NewQuote): number {
  const r = db().prepare(
    "INSERT INTO quotes(namespace, symbol, price, volume, as_of, fetched_at, source, prev_close, delay_sec, as_of_source) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).run(namespace, q.symbol, q.price, q.volume, q.as_of, q.fetched_at, q.source, q.prev_close, q.delay_sec, q.as_of_source);
  return Number(r.lastInsertRowid);
}

export interface PersistedScore {
  score: number; components: string; missing: string;
  version: number; inputs: string; evidence: string;
}

export function storeScore(namespace: string, symbol: string, quoteId: number, s: PersistedScore): void {
  db().prepare(`INSERT INTO quote_scores(namespace, symbol, quote_id, score, components, missing, version, inputs, evidence)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(namespace, symbol, quote_id) DO NOTHING`)
    .run(namespace, symbol, quoteId, s.score, s.components, s.missing, s.version, s.inputs, s.evidence);
}

export function readScore(namespace: string, symbol: string, quoteId: number): PersistedScore | null {
  const row = db().prepare("SELECT score, components, missing, version, inputs, evidence FROM quote_scores WHERE namespace = ? AND symbol = ? AND quote_id = ?")
    .get(namespace, symbol, quoteId) as PersistedScore | undefined;
  return row ?? null;
}

// ---- incremental honest baselines (Welford mean/variance of actual returns) ----

export interface SymbolBaseline {
  n_ret: number; std_ret: number | null;
  n_vol: number; avg_vol: number | null;
  range_hi: number | null; range_lo: number | null; range_n: number;
}

export function readBaseline(namespace: string, symbol: string): SymbolBaseline {
  const row = db().prepare("SELECT * FROM symbol_samples WHERE namespace = ? AND symbol = ?").get(namespace, symbol) as
    { n_ret: number; mean_ret: number; m2_ret: number; n_vol: number; avg_vol: number; range_hi: number | null; range_lo: number | null; range_n: number } | undefined;
  if (!row) return { n_ret: 0, std_ret: null, n_vol: 0, avg_vol: null, range_hi: null, range_lo: null, range_n: 0 };
  const variance = row.n_ret > 1 ? row.m2_ret / (row.n_ret - 1) : null;
  return {
    n_ret: row.n_ret, std_ret: variance != null && variance > 0 ? Math.sqrt(variance) : null,
    n_vol: row.n_vol, avg_vol: row.n_vol > 0 ? row.avg_vol : null,
    range_hi: row.range_hi, range_lo: row.range_lo, range_n: row.range_n,
  };
}

/** Fold one observation into baselines AFTER it has been scored. Returns prior return for chaining. */
export function observeSample(namespace: string, symbol: string, price: number, volume: number | null, prevPrice: number | null): void {
  const h = db();
  const row = h.prepare("SELECT * FROM symbol_samples WHERE namespace = ? AND symbol = ?").get(namespace, symbol) as
    { n_ret: number; mean_ret: number; m2_ret: number; n_vol: number; avg_vol: number; range_hi: number | null; range_lo: number | null; range_n: number } | undefined;
  const now = nowISO();
  if (!row) {
    h.prepare(`INSERT INTO symbol_samples(namespace, symbol, n_ret, mean_ret, m2_ret, n_vol, avg_vol, range_hi, range_lo, range_n, first_seen, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      namespace, symbol,
      prevPrice && prevPrice > 0 ? 1 : 0, prevPrice && prevPrice > 0 ? (price - prevPrice) / prevPrice : 0, 0,
      volume != null ? 1 : 0, volume ?? 0, price, price, 1, now, now);
    return;
  }
  let { n_ret, mean_ret, m2_ret, n_vol, avg_vol, range_hi, range_lo, range_n } = row;
  if (prevPrice && prevPrice > 0) {
    const r = (price - prevPrice) / prevPrice;
    n_ret += 1;
    const delta = r - mean_ret;
    mean_ret += delta / n_ret;
    m2_ret += delta * (r - mean_ret);
  }
  if (volume != null) {
    n_vol += 1;
    avg_vol += (volume - avg_vol) / n_vol;
  }
  range_hi = range_hi == null ? price : Math.max(range_hi, price);
  range_lo = range_lo == null ? price : Math.min(range_lo, price);
  range_n += 1;
  h.prepare("UPDATE symbol_samples SET n_ret=?, mean_ret=?, m2_ret=?, n_vol=?, avg_vol=?, range_hi=?, range_lo=?, range_n=?, updated_at=? WHERE namespace=? AND symbol=?")
    .run(n_ret, mean_ret, m2_ret, n_vol, avg_vol, range_hi, range_lo, range_n, now, namespace, symbol);
}

export function seedBaseline(namespace: string, symbol: string, avgVol: number, stdRet: number | null, hi: number | null, lo: number | null): void {
  db().prepare(`INSERT INTO symbol_samples(namespace, symbol, n_ret, mean_ret, m2_ret, n_vol, avg_vol, range_hi, range_lo, range_n, first_seen, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(namespace, symbol) DO UPDATE SET n_vol=excluded.n_vol, avg_vol=excluded.avg_vol,
      range_hi=excluded.range_hi, range_lo=excluded.range_lo, range_n=excluded.range_n, first_seen=excluded.first_seen, updated_at=excluded.updated_at`)
    .run(namespace, symbol, stdRet != null ? 10 : 0, 0, stdRet != null ? 9 * stdRet * stdRet : 0,
      10, avgVol, hi, lo, hi != null ? 10 : 0, nowISO(), nowISO());
}

export function samplesSince(namespace: string, symbol: string): string | null {
  const row = db().prepare("SELECT first_seen FROM symbol_samples WHERE namespace = ? AND symbol = ?")
    .get(namespace, symbol) as { first_seen: string | null } | undefined;
  return row?.first_seen ?? null;
}

export interface Observation {
  symbol: string; price: number; volume: number | null;
  asOf: string; fetchedAt: string; source: string;
  prevClose: number | null; delaySec: number | null; asOfSource: string;
}

export interface StoreResult {
  accepted: boolean; duplicate?: boolean; reason?: string;
  quoteId?: number; scored?: ScoredResult; eventId?: number;
  transitioned?: boolean;
}

export interface FetchStatus {
  attemptAt: string; provider: string; outcome: "accepted" | "duplicate" | "rejected" | "error";
  providerAsOf: string | null; reason: string | null; lastSuccessAt?: string | null; httpStatus?: number; price?: number;
}

/** Per-symbol fetch health, separate from observation time. Bounded to watched symbols. */
export function recordFetch(namespace: string, symbol: string, s: FetchStatus): void {
  db().prepare("INSERT INTO meta(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(`fetch:${namespace}:${symbol}`, JSON.stringify({ ...s, lastSuccessAt: s.outcome === "accepted" || s.outcome === "duplicate" ? s.attemptAt : fetchStatus(namespace, symbol)?.lastSuccessAt ?? null }));
}

export function fetchStatus(namespace: string, symbol: string): FetchStatus | null {
  const row = db().prepare("SELECT value FROM meta WHERE key = ?").get(`fetch:${namespace}:${symbol}`) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as FetchStatus;
  } catch {
    return null;
  }
}

/**
 * The single write path for observations. Reads baselines BEFORE incorporating
 * the observation, then commits quote + baseline update + persisted score +
 * event atomically. Rejects older timestamps and dedupes identical ones
 * without mutating anything. No provider I/O happens inside: callers fetch
 * first, then commit (so failures never leave partial state).
 */
export function scoreAndStore(namespace: string, obs: Observation): StoreResult {
  return tx((h) => {
    // Ordering and duplicates are judged WITHIN this observation's source
    // stream: a valid earlier-dated real-provider session quote must be able
    // to supersede a newer simulated quote, while out-of-order observations
    // from the same stream stay rejected.
    const prev = latestQuote(namespace, obs.symbol, obs.source);
    if (prev && obs.asOf < prev.as_of) {
      return { accepted: false, reason: `older timestamp than latest accepted ${obs.source} observation` };
    }
    if (prev && obs.asOf === prev.as_of
      && Number(prev.price) === obs.price && (prev.volume ?? null) === (obs.volume ?? null)) {
      return { accepted: false, duplicate: true, reason: "duplicate observation" };
    }
    if (prev && obs.asOf === prev.as_of) return { accepted: false, reason: "conflicting observation at existing provider timestamp" };
    let transitioned = false;
    if (obs.source === "finnhub" && namespace === LIVE_NS && !prev && hasSimHistory(h, namespace, obs.symbol)) {
      transitioned = transitionSymbolLive(h, namespace, obs.symbol, nowISO());
    }
    const prevPrice = prev ? Number(prev.price) : null;
    const base = readBaseline(namespace, obs.symbol);
    const hist = recentQuotes(namespace, obs.symbol, 7, obs.source).map((x) => Number(x.price));
    const closes = [...hist, obs.price];
    const scored = scoreQuote({
      price: obs.price, prevPrice, volume: obs.volume ?? 0,
      nRet: base.n_ret, stdRet: base.std_ret, nVol: base.n_vol, avgVol: base.avg_vol,
      rangeHi: base.range_hi, rangeLo: base.range_lo, rangeN: base.range_n, closes,
    });
    const quoteId = insertQuote(namespace, {
      symbol: obs.symbol, price: obs.price, volume: obs.volume,
      as_of: obs.asOf, fetched_at: obs.fetchedAt, source: obs.source,
      prev_close: obs.prevClose, delay_sec: obs.delaySec, as_of_source: obs.asOfSource,
    });
    // Statistics follow the display stream only: once real observations
    // exist, simulated rows are preserved but never feed real scoring.
    if (displaySource(namespace, obs.symbol) === obs.source) {
      observeSample(namespace, obs.symbol, obs.price, obs.volume, prevPrice);
    }
    storeScore(namespace, obs.symbol, quoteId, {
      score: scored.total, components: JSON.stringify(scored.components),
      missing: JSON.stringify(scored.missing), version: scored.version,
      inputs: JSON.stringify(scored.inputs),
      evidence: JSON.stringify({
        price: obs.price, prevPrice, volume: obs.volume,
        nRet: base.n_ret, stdRet: base.std_ret, nVol: base.n_vol, avgVol: base.avg_vol,
        rangeHi: base.range_hi, rangeLo: base.range_lo, rangeN: base.range_n, closes,
      }),
    });
    let eventId: number | undefined;
    if (scored.total >= THRESHOLD && scored.reasons.length > 0 && prevPrice != null) {
      const ret = (obs.price - prevPrice) / prevPrice;
      const fp = eventFingerprint(obs.symbol, scored.reasons, ret);
      const prior = recentFingerprint(namespace, fp, 60);
      // Suppress repeats of the same condition; allow material escalation (≥15 pts).
      if (!prior || scored.total >= prior.score + 15) {
        eventId = insertEvent({
          namespace, symbol: obs.symbol, score: scored.total, reasons: JSON.stringify(scored.reasons),
          summary: buildSummary(ret, scored.inputs.volRatio, scored.reasons),
          observed_price: obs.price, baseline_price: prevPrice, baseline_kind: "previous-observation",
          components: JSON.stringify(scored.components), source: obs.source,
          occurred_at: obs.asOf, fingerprint: fp, version: SCORE_VERSION,
        });
      }
    }
    return { accepted: true, quoteId, scored, eventId, transitioned };
  });
}

function hasSimHistory(h: DatabaseSync, namespace: string, symbol: string): boolean {
  const row = h.prepare("SELECT 1 AS x FROM quotes WHERE namespace = ? AND symbol = ? AND source = 'simulated' LIMIT 1")
    .get(namespace, symbol) as { x: number } | undefined;
  return !!row;
}

/** Has this symbol already been moved to real-provider statistics? */
export function isTransitioned(namespace: string, symbol: string): boolean {
  return getMeta(db(), `transition:${namespace}:${symbol}`) != null;
}

/**
 * Move a symbol to real-provider statistics: drop simulated-derived samples
 * and simulated-era review baselines, record the transition. Simulated quotes
 * and events are preserved untouched. Idempotent via the transition marker.
 */
export function transitionSymbolLive(h: DatabaseSync, namespace: string, symbol: string, at: string): boolean {
  if (getMeta(h, `transition:${namespace}:${symbol}`) != null) return false;
  h.prepare("DELETE FROM symbol_samples WHERE namespace = ? AND symbol = ?").run(namespace, symbol);
  h.prepare(`DELETE FROM item_baselines WHERE symbol = ? AND watchlist_id IN
    (SELECT id FROM watchlists WHERE is_demo = 0)`).run(symbol);
  setMetaOn(h, `transition:${namespace}:${symbol}`, JSON.stringify({ at, from: "simulated", to: "finnhub" }));
  return true;
}
export function sourceTransitions(namespace: string, symbols: string[]): { symbol: string; at: string; from: string; to: string }[] {
  const h = db();
  const out: { symbol: string; at: string; from: string; to: string }[] = [];
  for (const s of symbols) {
    const raw = h.prepare("SELECT value FROM meta WHERE key = ?").get(`transition:${namespace}:${s}`) as { value: string } | undefined;
    if (raw) {
      try {
        const v = JSON.parse(raw.value) as { at: string; from: string; to: string };
        out.push({ symbol: s, ...v });
      } catch { /* ignore corrupt marker */ }
    }
  }
  return out;
}

// ---- events ----

export interface StoredEvent extends Omit<ChangeEvent, "reasons"> {
  namespace: string; observed_price: number; baseline_price: number | null;
  baseline_kind: string | null; reasons: string; components: string; source: string; version: number;
  fingerprint: string;
}

export function recentFingerprint(namespace: string, fingerprint: string, minutes: number): StoredEvent | undefined {
  const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();
  return db().prepare("SELECT * FROM events WHERE namespace = ? AND fingerprint = ? AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT 1")
    .get(namespace, fingerprint, cutoff) as StoredEvent | undefined;
}

export function insertEvent(e: Omit<StoredEvent, "id">): number {
  const r = db().prepare(`INSERT INTO events(namespace, symbol, score, reasons, summary, observed_price,
    baseline_price, baseline_kind, components, source, occurred_at, fingerprint, version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    e.namespace, e.symbol, e.score, e.reasons, e.summary, e.observed_price, e.baseline_price,
    e.baseline_kind, e.components, e.source, e.occurred_at, e.fingerprint, e.version);
  return Number(r.lastInsertRowid);
}

export interface UnreadEvent extends StoredEvent { company?: never }

export function unreadEvents(namespace: string, watchlistId: string, userId: string, symbols: string[], limit: number): StoredEvent[] {
  if (symbols.length === 0) return [];
  const h = db();
  const tr = h.prepare("SELECT tracking_since FROM reviews WHERE watchlist_id = ? AND user_id = ?")
    .get(watchlistId, userId) as { tracking_since: string } | undefined;
  if (!tr) return [];
  const placeholders = symbols.map(() => "?").join(",");
  // Membership-start filtering happens inside SQL, BEFORE sorting/limiting,
  // so pre-addition events can never consume briefing slots.
  const args: SQLInputValue[] = [watchlistId, userId, namespace, ...symbols, tr.tracking_since, watchlistId, watchlistId, limit];
  return h.prepare(`SELECT e.* FROM events e
    LEFT JOIN reviewed_events r ON r.event_id = e.id AND r.watchlist_id = ? AND r.user_id = ?
    WHERE e.namespace = ? AND e.symbol IN (${placeholders}) AND e.occurred_at >= ?
      AND e.occurred_at >= (SELECT added_at FROM items WHERE watchlist_id = ? AND symbol = e.symbol)
      AND e.id > (SELECT event_floor FROM items WHERE watchlist_id = ? AND symbol = e.symbol)
      AND r.event_id IS NULL
    ORDER BY e.score DESC LIMIT ?`).all(...args) as unknown as StoredEvent[];
}

export function unreadCount(namespace: string, watchlistId: string, userId: string, symbols: string[]): number {
  return unreadEvents(namespace, watchlistId, userId, symbols, 1000).length;
}

// ---- review state ----

export function trackingSince(watchlistId: string, userId: string): string | null {
  const row = db().prepare("SELECT tracking_since FROM reviews WHERE watchlist_id = ? AND user_id = ?")
    .get(watchlistId, userId) as { tracking_since: string } | undefined;
  return row?.tracking_since ?? null;
}

export function lastReviewedAt(watchlistId: string, userId: string): string | null {
  const row = db().prepare("SELECT reviewed_at FROM reviews WHERE watchlist_id = ? AND user_id = ?")
    .get(watchlistId, userId) as { reviewed_at: string | null } | undefined;
  return row?.reviewed_at ?? null;
}

export function baselineFor(watchlistId: string, userId: string, symbol: string): { price: number; as_of: string; source: string; membership_id: string } | null {
  const row = db().prepare(`SELECT b.price, b.as_of, b.source, b.membership_id FROM item_baselines b JOIN items i ON i.id = b.membership_id JOIN watchlists w ON w.id = i.watchlist_id WHERE b.watchlist_id = ? AND b.user_id = ? AND b.symbol = ? AND b.source = COALESCE((SELECT source FROM quotes WHERE namespace = CASE WHEN w.is_demo = 1 THEN 'demo:' || w.user_id ELSE 'live' END AND symbol = b.symbol ORDER BY (source = 'finnhub') DESC, as_of DESC, id DESC LIMIT 1), 'unknown')`)
    .get(watchlistId, userId, symbol) as { price: number; as_of: string; source: string; membership_id: string } | undefined;
  return row ?? null;
}

/** Explicit first tracking establishment. Sets item baselines to current quotes. */
export function startTracking(watchlistId: string, userId: string, namespace: string, symbols: string[], at = nowISO()): string {
  return tx((h) => {
    const now = at;
    h.prepare("INSERT INTO reviews(watchlist_id, user_id, tracking_since, reviewed_at) VALUES (?,?,?,?) ON CONFLICT(watchlist_id, user_id) DO UPDATE SET reviewed_at=excluded.reviewed_at")
      .run(watchlistId, userId, now, now);
    const ib = h.prepare("INSERT INTO item_baselines(watchlist_id, user_id, symbol, price, quote_id, as_of, source, membership_id) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(watchlist_id, user_id, symbol) DO UPDATE SET price=excluded.price, quote_id=excluded.quote_id, as_of=excluded.as_of, source=excluded.source, membership_id=excluded.membership_id WHERE excluded.source != item_baselines.source OR excluded.as_of >= item_baselines.as_of OR item_baselines.source IS NULL");
    for (const s of symbols) {
      const q = displayQuote(namespace, s);
      const member = itemsFor(watchlistId).find(i => i.symbol === s);
      if (q && member) ib.run(watchlistId, userId, s, q.price, q.id, q.as_of, q.source, member.id);
    }
    return now;
  });
}

export interface SnapshotBaseline { price: number; asOf: string; addedAt: string; source?: string; membershipId?: string }

export interface BriefingSnapshot { token: string; eventIds: number[]; baselines: Record<string, SnapshotBaseline> }

export function createSnapshot(watchlistId: string, userId: string, eventIds: number[], baselines: Record<string, SnapshotBaseline>): string {
  const members = itemsFor(watchlistId);
  const wl = getOwnedWatchlist(userId, watchlistId);
  for (const [symbol, b] of Object.entries(baselines)) {
    b.membershipId ??= members.find(i => i.symbol === symbol)?.id;
    b.source ??= displaySource(wl?.is_demo ? demoNs(userId) : LIVE_NS, symbol);
  }
  const token = uid();
  db().prepare("INSERT INTO briefing_snapshots(token, watchlist_id, user_id, event_ids, baselines, created_at) VALUES (?,?,?,?,?,?)")
    .run(token, watchlistId, userId, JSON.stringify(eventIds), JSON.stringify(baselines), nowISO());
  return token;
}

export function getSnapshot(token: string): (BriefingSnapshot & { watchlist_id: string; user_id: string }) | null {
  const row = db().prepare("SELECT * FROM briefing_snapshots WHERE token = ?").get(token) as
    { token: string; watchlist_id: string; user_id: string; event_ids: string; baselines: string } | undefined;
  if (!row) return null;
  return { token: row.token, watchlist_id: row.watchlist_id, user_id: row.user_id, eventIds: JSON.parse(row.event_ids), baselines: JSON.parse(row.baselines) };
}

/**
 * Acknowledge exactly the events in the server-issued snapshot. Idempotent,
 * monotonic (older tabs cannot regress baselines), transactional.
 * Baselines apply only when the item's membership period matches the one the
 * briefing was built on, so an old token can never restore a baseline from
 * an earlier membership period. Reports only newly-reviewed events.
 */
export function ackSnapshot(userId: string, watchlistId: string, token: string, onlyIds?: number[]): { reviewed: number; already: number; reviewedAt: string } {
  return tx((h) => {
    const snap = h.prepare("SELECT * FROM briefing_snapshots WHERE token = ? AND watchlist_id = ? AND user_id = ?")
      .get(token, watchlistId, userId) as { event_ids: string; baselines: string } | undefined;
    if (!snap) throw new Error("unknown or expired review token; refetch the briefing and retry");
    const now = nowISO();
    const snapIds = JSON.parse(snap.event_ids) as number[];
    const ids = onlyIds ? onlyIds.filter((id) => snapIds.includes(id)) : snapIds;
    if (onlyIds && ids.length !== onlyIds.length) throw new Error("briefing changed; refetch and retry");
    const baselines = JSON.parse(snap.baselines) as Record<string, SnapshotBaseline>;
    const ri = h.prepare("INSERT OR IGNORE INTO reviewed_events(watchlist_id, user_id, event_id, reviewed_at) VALUES (?,?,?,?)");
    let fresh = 0;
    for (const id of ids) fresh += Number(ri.run(watchlistId, userId, id, now).changes);
    const cur = h.prepare("SELECT id, symbol, added_at FROM items WHERE watchlist_id = ?")
      .all(watchlistId) as unknown as { id: string; symbol: string; added_at: string }[];
    const addedAt = new Map(cur.map((r) => [r.symbol, r.added_at]));
    const ib = h.prepare(`INSERT INTO item_baselines(watchlist_id,user_id,symbol,price,quote_id,as_of,source,membership_id) VALUES (?,?,?,?,NULL,?,?,?)
      ON CONFLICT(watchlist_id,user_id,symbol) DO UPDATE SET price=excluded.price,quote_id=NULL,as_of=excluded.as_of,source=excluded.source,membership_id=excluded.membership_id
      WHERE item_baselines.source IS NULL OR item_baselines.source != excluded.source OR excluded.as_of >= item_baselines.as_of`);
    const wlRow = h.prepare("SELECT is_demo FROM watchlists WHERE id = ?").get(watchlistId) as { is_demo: number } | undefined;
    const ackNs = wlRow && wlRow.is_demo ? demoNs(userId) : LIVE_NS;
    for (const [sym, b] of Object.entries(baselines)) {
      // Skip baselines for absent items or earlier membership periods.
      const cur = addedAt.get(sym);
      if (cur == null || cur !== b.addedAt || !b.membershipId || !itemsFor(watchlistId).some(i => i.id === b.membershipId && i.symbol === sym)) continue;
      // Skip baselines from a previous source generation: a simulated price
      // must never become the baseline for real-provider changes.
      if (!b.source || displaySource(ackNs, sym) !== b.source) continue;
      ib.run(watchlistId, userId, sym, b.price, b.asOf, b.source, b.membershipId);
    }
    h.prepare("UPDATE reviews SET reviewed_at = ? WHERE watchlist_id = ? AND user_id = ?").run(now, watchlistId, userId);
    // Snapshot rows are retained so repeating an acknowledgement is a
    // successful no-op (INSERT OR IGNORE); pruneRetention expires them.
    return { reviewed: fresh, already: ids.length - fresh, reviewedAt: now };
  });
}

// ---- retention + health ----

/**
 * Explicit cleanup for observations duplicated by superseded ingestion code
 * (no per-stream ordering guard). Collapses rows sharing
 * (namespace, symbol, source, as_of), keeping the earliest id, and collapses
 * same-fingerprint/same-time events the same way. Removed ids are backed up
 * in meta before deletion; reviewed refs are re-pointed, never orphaned.
 * Safe to re-run: second pass finds nothing.
 */
export function collapseDuplicateObservations(): { quotes: number; events: number; backupKey: string } {
  return tx((h) => {
    const dupQ = h.prepare(`SELECT namespace, symbol, source, as_of, MIN(id) AS keep, COUNT(*) AS n
      FROM quotes GROUP BY namespace, symbol, source, as_of HAVING n > 1`).all() as unknown as
      { namespace: string; symbol: string; source: string; as_of: string; keep: number; n: number }[];
    const backupRows = { quotes: h.prepare("SELECT * FROM quotes").all(), scores: h.prepare("SELECT * FROM quote_scores").all(), events: h.prepare("SELECT * FROM events").all(), reviewed: h.prepare("SELECT * FROM reviewed_events").all(), baselines: h.prepare("SELECT * FROM item_baselines").all(), samples: h.prepare("SELECT * FROM symbol_samples").all() };
    let quotes = 0;
    const removedQuotes: number[] = [];
    for (const g of dupQ) {
      const ids = h.prepare("SELECT id FROM quotes WHERE namespace = ? AND symbol = ? AND source = ? AND as_of = ? AND id != ? ORDER BY id")
        .all(g.namespace, g.symbol, g.source, g.as_of, g.keep) as unknown as { id: number }[];
      for (const r of ids) {
        h.prepare("DELETE FROM quote_scores WHERE namespace = ? AND symbol = ? AND quote_id = ?").run(g.namespace, g.symbol, r.id);
        h.prepare("UPDATE item_baselines SET quote_id = ? WHERE quote_id = ?").run(g.keep, r.id);
        h.prepare("DELETE FROM quotes WHERE id = ?").run(r.id);
        removedQuotes.push(r.id);
        quotes += 1;
      }
    }
    const dupE = h.prepare(`SELECT namespace, symbol, fingerprint, occurred_at, MIN(id) AS keep, COUNT(*) AS n
      FROM events GROUP BY namespace, symbol, fingerprint, occurred_at HAVING n > 1`).all() as unknown as
      { namespace: string; symbol: string; fingerprint: string; occurred_at: string; keep: number; n: number }[];
    let events = 0;
    const removedEvents: number[] = [];
    for (const g of dupE) {
      const ids = h.prepare("SELECT id FROM events WHERE namespace = ? AND symbol = ? AND fingerprint = ? AND occurred_at = ? AND id != ? ORDER BY id")
        .all(g.namespace, g.symbol, g.fingerprint, g.occurred_at, g.keep) as unknown as { id: number }[];
      for (const r of ids) {
        h.prepare("INSERT OR IGNORE INTO reviewed_events(watchlist_id,user_id,event_id,reviewed_at) SELECT watchlist_id,user_id,?,reviewed_at FROM reviewed_events WHERE event_id = ?").run(g.keep,r.id);
        h.prepare("DELETE FROM reviewed_events WHERE event_id = ?").run(r.id);
        h.prepare("DELETE FROM events WHERE id = ?").run(r.id);
        removedEvents.push(r.id);
        events += 1;
      }
    }
    const backupKey = `dedupe_backup:${nowISO()}`;
    setMetaOn(h, backupKey, JSON.stringify({ at: nowISO(), ...backupRows, removedQuotes, removedEvents }));
    // Symbols that already hold real-provider history move to real-provider
    // statistics now (same transition as first acceptance): simulated-derived
    // samples and simulated-era baselines are dropped, never blended.
    const transitioned: string[] = [];
    const finSyms = h.prepare("SELECT DISTINCT symbol FROM quotes WHERE namespace = 'live' AND source = 'finnhub'")
      .all() as unknown as { symbol: string }[];
    for (const r of finSyms) {
      if (hasSimHistory(h, LIVE_NS, r.symbol) && transitionSymbolLive(h, LIVE_NS, r.symbol, nowISO())) {
        transitioned.push(r.symbol);
      }
    }
    setMetaOn(h, "dedupe_migration", JSON.stringify({ status: "ok", at: nowISO(), quotes, events, backupKey, transitioned }));
    return { quotes, events, backupKey };
  });
}

export function dedupeStatus(): Record<string, unknown> {
  const raw = getMeta(db(), "dedupe_migration");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : { status: "never-run" };
}

export function pruneRetention(): { quotes: number; events: number } {
  const h = db();
  const qCut = new Date(Date.now() - 7 * 86400_000).toISOString();
  const eCut = new Date(Date.now() - 30 * 86400_000).toISOString();
  const q = h.prepare("DELETE FROM quotes WHERE as_of < ?").run(qCut);
  const e = h.prepare("DELETE FROM events WHERE occurred_at < ?").run(eCut);
  h.prepare("DELETE FROM briefing_snapshots WHERE created_at < ?").run(new Date(Date.now() - 86400_000).toISOString());
  const out = { quotes: Number(q.changes), events: Number(e.changes) };
  setMeta("retention_last_prune", JSON.stringify({ at: nowISO(), eventsCutoff: eCut, quotesCutoff: qCut, ...out }));
  return out;
}

export interface CoverageInfo {
  oldestEventAt: string | null;
  retentionCutoff: string | null;
  prunedEvents: number;
  incomplete: boolean;
  note: string | null;
}

/**
 * A coverage warning fires only when retention actually deleted events that
 * overlap the tracking window — the mere age of the oldest retained event
 * is not evidence of a gap.
 */
export function coverageFor(namespace: string, trackingSince: string): CoverageInfo {
  const oldest = oldestEventAt(namespace);
  let cutoff: string | null = null;
  let pruned = 0;
  try {
    const raw = getMetaValue("retention_last_prune");
    if (raw) {
      const p = JSON.parse(raw) as { eventsCutoff?: string; events?: number };
      cutoff = p.eventsCutoff ?? null;
      pruned = p.events ?? 0;
    }
  } catch { /* treat as unknown */ }
  const incomplete = pruned > 0 && cutoff != null && trackingSince < cutoff;
  return {
    oldestEventAt: oldest, retentionCutoff: cutoff, prunedEvents: pruned, incomplete,
    note: incomplete
      ? "Some events from early in your tracking window expired under retention and are unavailable — absence of older events is a coverage gap, not proof nothing happened."
      : null,
  };
}

export function oldestEventAt(namespace: string): string | null {
  const row = db().prepare("SELECT MIN(occurred_at) AS m FROM events WHERE namespace = ?").get(namespace) as { m: string | null };
  return row.m;
}

export function clearNamespace(namespace: string): void {
  tx((h) => {
    h.prepare("DELETE FROM quotes WHERE namespace = ?").run(namespace);
    h.prepare("DELETE FROM events WHERE namespace = ?").run(namespace);
  });
}

export function setMeta(key: string, value: string): void {
  db().prepare("INSERT INTO meta(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

export function getMetaValue(key: string): string | null {
  const row = db().prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
