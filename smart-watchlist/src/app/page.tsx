"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { fmtMoney, timeAgo, directionOf } from "@/lib/format";

interface Comp { surprise: number; volume: number; threshold: number; reversal: number }
interface Quality { kind: "simulated" | "live" | "delayed" | "stale" | "unavailable"; detail: string }
interface Quote {
  symbol: string; price: number; prevClose: number | null; dayChangePct: number | null;
  dayChangeAbs: number | null; sessionChange: string | null;
  volume: number | null; score: number; reasons: string[];
  missing: string[]; summary: string | null; sparkline: number[];
  freshness: string; freshnessLabel: string; isStale: boolean;
  high52w: number | null; low52w: number | null;
  z: number | null; volRatio: number | null; comp: Comp; chips: string[];
  company: string | null; source: string; asOf: string | null;
  sinceReview: { pct: number; baselineAsOf: string } | null;
  quality: Quality; version: number; currency: "USD" | "INR";
}
interface BriefEvent {
  id: number; symbol: string; company: string | null; score: number;
  reasons: string[]; summary: string; observed_price: number;
  baseline_price: number | null; baseline_kind: string | null;
  components: Record<string, number>; source: string; occurred_at: string; version: number;
}
interface Suggest { symbol: string; name: string | null; exchange: string | null }

type Tier = "high" | "watch" | "elevated" | "normal";
const tierOf = (s: number): Tier => (s >= 80 ? "high" : s >= 55 ? "watch" : s >= 30 ? "elevated" : "normal");
const TIER_LABEL: Record<Tier, string> = { high: "High Attention", watch: "Worth Watching", elevated: "Elevated", normal: "Normal" };

const SENS = { conservative: 70, balanced: 55, sensitive: 40 } as const;
type SensKey = keyof typeof SENS;
const SERVER_STORE_THRESHOLD = 55;

function missingLabel(m: string): string {
  return {
    baseline: "no prior observation",
    volatility: "needs 5+ past moves",
    volume_baseline: "needs 3+ volume samples",
    observed_range: "needs 5+ observations",
    trend_window: "needs 7 closes",
  }[m] ?? m;
}

// Recent-observation evidence (latest vs previous accepted observation).
function describe(q: Quote): string {
  const pct = q.dayChangePct;
  if (pct == null) return "Not available — no prior observation yet.";
  const dir = pct <= -2 ? "Heavy downside move" : pct < 0 ? "Downward drift"
    : pct >= 2 ? "Strong upward move" : pct > 0 ? "Upward drift" : "Flat trading";
  if (Math.abs(pct) < 0.05) return "Flat trading on normal volume.";
  const vol = q.volRatio != null && q.volRatio >= 1.8 ? `on ${q.volRatio.toFixed(1)}× recent-sample average volume` : "on normal volume";
  const th = q.reasons.includes("range_high") ? ", reaching a new observed high"
    : q.reasons.includes("range_low") ? ", reaching a new observed low" : "";
  const rev = q.reasons.includes("trend_reversal") ? " with a recent trend reversal" : "";
  return `${dir} ${vol}${th}${rev}.`;
}

// Compact ordinary-stock row: one aligned grid row (~64px) on desktop,
// two compact lines on mobile. Signal status and data quality are separate:
// stale rows never claim calm market behavior.
function QuietRow({ q, onOpen, onRemove, removing }: {
  q: Quote; onOpen: (s: string) => void; onRemove: (s: string) => void; removing: boolean;
}) {
  const d = directionOf(q.sinceReview?.pct ?? null);
  const pct = q.sinceReview ? `${d === "down" ? "−" : d === "up" ? "+" : ""}${Math.abs(q.sinceReview.pct).toFixed(2)}%` : "N/A";
  const pctCls = d === "flat" ? "text-zinc-500" : d === "up" ? "text-emerald-400/90" : "text-red-400/90";
  const status = q.quality.kind === "stale"
    ? <span className="text-[11px] text-amber-200/80" title={q.freshnessLabel}>Stale quote</span>
    : q.quality.kind === "unavailable"
      ? <span className="text-[11px] text-zinc-500" title={q.freshnessLabel}>Awaiting update</span>
      : <span className="text-[11px] text-zinc-600" title={q.freshnessLabel}>Fresh</span>;
  return (
    <li className="px-3 py-2 hover:bg-zinc-800/40 sm:grid sm:min-h-[64px] sm:grid-cols-[minmax(0,1.7fr)_104px_104px_128px_auto] sm:items-center sm:gap-3 sm:py-1">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="truncate text-[13px]"><span className="font-mono font-semibold text-zinc-100">{q.symbol}</span><span className="ml-1.5 text-xs text-zinc-400">{q.company}</span></span>
        <span className="tnum shrink-0 font-mono text-[13px] text-zinc-200 sm:hidden">{fmtMoney(q.symbol, q.price)}</span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 sm:hidden">
        <span className={`tnum font-mono text-xs ${pctCls}`} title="Change since your last review">{pct}</span>
        <span className="flex items-center gap-2">
          {status}
          <button onClick={() => onOpen(q.symbol)} aria-label={`View ${q.symbol} details`} className="rounded px-1.5 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-zinc-500">Details</button>
          <button onClick={() => onRemove(q.symbol)} disabled={removing} aria-label={`Remove ${q.symbol} from watchlist`} className="rounded px-1.5 py-1 text-[11px] text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-zinc-500">✕</button>
        </span>
      </div>
      <span className="tnum hidden text-right font-mono text-[13px] text-zinc-200 sm:block">{fmtMoney(q.symbol, q.price)}</span>
      <span className={`tnum hidden text-right font-mono text-xs tabular-nums sm:block ${pctCls}`} title="Change since your last review">{pct}</span>
      <span className="hidden sm:block">{status}</span>
      <span className="hidden items-center gap-1 sm:flex">
        <button onClick={() => onOpen(q.symbol)} aria-label={`View ${q.symbol} details`} className="rounded px-1.5 py-1 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-zinc-500">Details</button>
        <button onClick={() => onRemove(q.symbol)} disabled={removing} aria-label={`Remove ${q.symbol} from watchlist`} className="rounded px-1.5 py-1 text-[11px] text-zinc-700 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-zinc-500">✕</button>
      </span>
    </li>
  );
}

function Spark({ data, up, baseline, markEvent, label }: { data: number[]; up: boolean; baseline?: number; markEvent?: boolean; label?: boolean }) {
  if (!data || data.length < 2) return <span className="text-xs text-zinc-700">—</span>;
  const w = 88, h = 30;
  const all = baseline != null ? [...data, baseline] : data;
  const min = Math.min(...all), max = Math.max(...all), span = max - min || 1;
  const X = (i: number) => (i / (data.length - 1)) * (w - 4) + 2;
  const Y = (v: number) => h - 3 - ((v - min) / span) * (h - 6);
  const pts = data.map((v, i) => `${X(i)},${Y(v)}`).join(" ");
  const last = data[data.length - 1];
  return (
    <span className="inline-flex shrink-0 flex-col items-end gap-0.5">
      <svg width={w} height={h} role="img" aria-label={`Recent price samples, last ${last}`}>
        <title>{`Recent samples · low ${Math.min(...data)} · high ${Math.max(...data)} · last ${last}`}</title>
        {baseline != null && (
          <line x1="2" x2={w - 2} y1={Y(baseline)} y2={Y(baseline)} stroke="#52525b" strokeWidth="1" strokeDasharray="3 2" />
        )}
        <polyline points={pts} fill="none" stroke={up ? "#34d399" : "#f87171"} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        {markEvent && <circle cx={X(data.length - 1)} cy={Y(last)} r="2.5" fill={up ? "#34d399" : "#f87171"} />}
      </svg>
      {label && <span className="font-mono text-[9px] uppercase tracking-wider text-zinc-600">samples</span>}
    </span>
  );
}

function TierTag({ score }: { score: number }) {
  const t = tierOf(score);
  const cls = t === "high"
    ? "bg-red-500/15 text-red-300"
    : t === "watch"
      ? "bg-amber-500/15 text-amber-300"
      : t === "elevated"
        ? "bg-amber-500/5 text-amber-200/60"
        : "bg-zinc-800/70 text-zinc-500";
  return <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-xs ${cls}`}>{score} · {TIER_LABEL[t]}</span>;
}

function Bar({ label, pts, max }: { label: string; pts: number; max: number }) {
  return (
    <div>
      <div className="flex justify-between text-xs"><span className="text-zinc-400">{label}</span><span className="tnum text-zinc-300">{pts}/{max}</span></div>
      <div className="mt-0.5 h-1.5 rounded bg-zinc-800">
        <div className="h-1.5 rounded bg-zinc-200 transition-all" style={{ width: `${Math.min((pts / max) * 100, 100)}%` }} />
      </div>
    </div>
  );
}

function Skeleton({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-zinc-800/60 ${className}`} />;
}

export default function Home() {
  const [wlId, setWlId] = useState<string | null>(null);
  const [liveWlId, setLiveWlId] = useState<string | null>(null);
  const [wlName, setWlName] = useState("");
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [events, setEvents] = useState<BriefEvent[]>([]);
  const [reviewToken, setReviewToken] = useState<string | null>(null);
  const [tracking, setTracking] = useState<boolean | null>(null);
  const [trackingSince, setTrackingSince] = useState<string | null>(null);
  const [reviewedAt, setReviewedAt] = useState<string | null>(null);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [coverage, setCoverage] = useState<{ oldestEventAt: string | null; retentionCutoff: string | null; prunedEvents: number; incomplete: boolean; note: string | null } | null>(null);
  const [ackError, setAckError] = useState<string | null>(null);
  const [acking, setAcking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [market, setMarket] = useState({ open: true, label: "", note: "" });
  const [mode, setMode] = useState("simulated");
  const [input, setInput] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [suggest, setSuggest] = useState<Suggest[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [drawer, setDrawer] = useState<string | null>(null);
  const [history, setHistory] = useState<{ price: number; asOf: string; source: string }[]>([]);
  const [howOpen, setHowOpen] = useState(false);
  const [demoFrozen, setDemoFrozen] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoHint, setDemoHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "attention">(
    () => (typeof sessionStorage !== "undefined" && sessionStorage.getItem("sw_filter") === "attention" ? "attention" : "all"));
  const [sens, setSens] = useState<SensKey>(
    () => (typeof localStorage !== "undefined" && (["conservative", "balanced", "sensitive"] as string[]).includes(localStorage.getItem("sw_sens") ?? "")
      ? (localStorage.getItem("sw_sens") as SensKey) : "balanced"));
  const [onboardOff, setOnboardOff] = useState(
    () => typeof localStorage !== "undefined" && localStorage.getItem("sw_onboard") === "off");
  const [toasts, setToasts] = useState<{ id: number; msg: string }[]>([]);
  const inFlight = useRef(false);
  const toastId = useRef(0);
  const demoFrozenRef = useRef(false);
  const searchTimer = useRef<NodeJS.Timeout | null>(null);
  const briefingReq = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const pushToast = useCallback((msg: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  }, []);

  const loadMeta = useCallback(async (wid: string) => {
    const wRes = await fetch(`/api/watchlists/${wid}`);
    if (wRes.status === 404) throw new Error("Watchlist not found");
    if (!wRes.ok) throw new Error("Could not load watchlist");
    const w = await wRes.json();
    setWlName(w.watchlist?.name ?? "");
    if (w.market) setMarket(w.market);
    if (w.mode) {
      setMode(w.mode);
      if (!demoFrozenRef.current && w.mode === "demo-simulated") setDemoFrozen(true);
    }
  }, []);

  // One consistent briefing snapshot: quotes, events, and review token from a
  // single request. Stale responses (after a watchlist switch) are discarded.
  const loadBriefing = useCallback(async (wid: string, opts?: { quiet?: boolean }) => {
    const reqId = ++briefingReq.current;
    if (!opts?.quiet) setRefreshing(true);
    setLoadError(null);
    try {
      const cRes = await fetch(`/api/watchlists/${wid}/changes?include=quotes`);
      if (cRes.status === 404) throw new Error("Watchlist not found");
      if (!cRes.ok) throw new Error("Refresh failed; showing last loaded state");
      if (reqId !== briefingReq.current) return; // superseded by a newer request
      const c = await cRes.json();
      setQuotes((c.quotes ?? []).slice().sort((a: Quote, b: Quote) => b.score - a.score));
      setTracking(c.tracking);
      setTrackingSince(c.trackingSince ?? null);
      setReviewedAt(c.reviewedAt ?? null);
      setEvents(c.events ?? []);
      setReviewToken(c.reviewToken ?? null);
      setUnreadTotal(c.unreadTotal ?? 0);
      setCoverage(c.coverage?.incomplete ? c.coverage : null);
      setAckError(null);
    } catch (e) {
      if (reqId !== briefingReq.current) return;
      setLoadError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      if (reqId === briefingReq.current) {
        inFlight.current = false;
        setRefreshing(false);
        setLoading(false);
      }
    }
  }, []);

  const boot = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      let wid = wlId;
      if (!wid) {
        const r = await fetch("/api/watchlists");
        if (!r.ok) throw new Error("Could not reach the server");
        wid = (await r.json()).defaultWatchlistId;
        setWlId(wid);
        setLiveWlId((v) => v ?? wid);
      }
      if (!wid) return;
      await loadMeta(wid);
      await loadBriefing(wid);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not reach the server");
      setLoading(false);
      inFlight.current = false;
    }
  }, [wlId, loadMeta, loadBriefing]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional mount fetch
  useEffect(() => { void boot(); }, [boot]);
  useEffect(() => {
    const t = setInterval(() => { if (wlId && !document.hidden) void loadBriefing(wlId, { quiet: true }); }, 30000);
    const onVis = () => { if (wlId && !document.hidden) void loadBriefing(wlId, { quiet: true }); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [wlId, loadBriefing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setDrawer(null); setHowOpen(false); setSuggestOpen(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Drawer focus trap + restoration.
  useEffect(() => {
    if (!drawer || !dialogRef.current) return;
    const root = dialogRef.current;
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    const close = root.querySelector<HTMLButtonElement>("[data-autofocus]");
    close?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = Array.from(root.querySelectorAll<HTMLElement>("button, [href], input, summary, [tabindex]:not([tabindex='-1'])"))
        .filter((el) => !el.hasAttribute("disabled"));
      if (items.length === 0) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      returnFocusRef.current?.focus?.();
    };
  }, [drawer]);

  async function startTrackingNow() {
    if (!wlId || starting) return;
    setStarting(true);
    try {
      const r = await fetch(`/api/watchlists/${wlId}/tracking/start`, { method: "POST" });
      if (!r.ok) throw new Error("Could not start tracking");
      pushToast("Tracking started from here");
      await loadBriefing(wlId);
    } catch {
      pushToast("Could not start tracking — retry");
    } finally {
      setStarting(false);
    }
  }

  async function acknowledge() {
    if (!wlId || !reviewToken || acking) return;
    setAcking(true);
    setAckError(null);
    try {
      const ids = visibleEvents.map((e) => e.id);
      const r = await fetch(`/api/watchlists/${wlId}/mark-seen`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: reviewToken, eventIds: ids }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Review failed — nothing was acknowledged");
      if (j.reviewed > 0) pushToast(j.reviewed === 1 ? "1 change marked as reviewed" : `${j.reviewed} changes marked as reviewed`);
      else pushToast("Already reviewed — nothing new to acknowledge");
      await loadBriefing(wlId);
    } catch (e) {
      // Retain everything on screen and offer retry.
      setAckError(e instanceof Error ? e.message : "Review failed — nothing was acknowledged");
    } finally {
      setAcking(false);
    }
  }

  async function demoAction(action: "start" | "advance" | "inject" | "reset") {
    if (demoBusy) return;
    setDemoBusy(true);
    try {
      const r = await fetch("/api/demo", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Demo action failed");
      demoFrozenRef.current = true;
      setDemoFrozen(true);
      setWlId(j.watchlistId);
      setDemoHint(j.nextHint ?? null);
      pushToast(action === "reset" ? "Demo reset — flat baselines, no events yet" : action === "inject" ? "Demo event injected" : "Demo scenario advanced");
      await loadMeta(j.watchlistId);
      await loadBriefing(j.watchlistId);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Demo action failed");
    } finally {
      setDemoBusy(false);
    }
  }

  async function exitDemo() {
    demoFrozenRef.current = false;
    setDemoFrozen(false);
    setDemoHint(null);
    try {
      const r = await fetch("/api/watchlists");
      if (!r.ok) throw new Error("unreachable");
      const j = await r.json();
      setLiveWlId(j.defaultWatchlistId);
      setWlId(j.defaultWatchlistId);
      await loadMeta(j.defaultWatchlistId);
      await loadBriefing(j.defaultWatchlistId);
    } catch {
      if (liveWlId) setWlId(liveWlId);
      pushToast("Back to your live watchlist");
    }
  }

  async function addSymbol(raw: string) {
    const sym = raw.trim().toUpperCase();
    if (!sym || !wlId || addBusy) return;
    setErr(null);
    setSuggestOpen(false);
    setAddBusy(true);
    try {
      const r = await fetch(`/api/watchlists/${wlId}/items`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbol: sym }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Failed to add");
      setInput(""); // cleared only after the server confirms
      pushToast(j.deduped ? `${sym} is already watched` : `${sym} added — tracking starts now`);
      await loadBriefing(wlId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to add");
    } finally {
      setAddBusy(false);
    }
  }

  async function remove(sym: string) {
    if (!wlId || removing) return;
    setRemoving(sym);
    try {
      const r = await fetch(`/api/watchlists/${wlId}/items/${sym}`, { method: "DELETE" });
      if (!r.ok) throw new Error("remove failed");
      setQuotes((q) => q.filter((x) => x.symbol !== sym));
      pushToast(`${sym} removed — re-adding starts fresh tracking`);
    } catch {
      pushToast(`Could not remove ${sym}`);
    } finally {
      setRemoving(null);
    }
  }

  async function openDrawer(sym: string) {
    setDrawer(sym);
    setHistory([]);
    try {
      const r = await fetch(`/api/symbols/${sym}/history?watchlistId=${wlId}`);
      if (!r.ok) throw new Error("history failed");
      const j = await r.json();
      setHistory(j?.samples ?? j?.history ?? []);
    } catch {
      pushToast("Could not load recent samples");
    }
  }

  function onSearchChange(v: string) {
    setInput(v.toUpperCase());
    setActiveIdx(-1);
    setSearchError(null);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!v.trim()) { setSuggest([]); setSuggestOpen(false); setSearchBusy(false); return; }
    setSearchBusy(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/symbols/search?q=${encodeURIComponent(v)}`);
        if (!r.ok) throw new Error("search failed");
        const j = await r.json();
        setSuggest(j.results ?? []);
        setSuggestOpen(true);
      } catch {
        setSearchError("Search unavailable — press Enter to add the typed symbol anyway");
        setSuggest([]);
        setSuggestOpen(true);
      } finally {
        setSearchBusy(false);
      }
    }, 150);
  }

  const threshold = SENS[sens];
  const visibleEvents = events.filter((e) => e.score >= threshold);
  const hiddenBySens = events.length - visibleEvents.length;
  const attn = quotes.filter((q) => q.score >= threshold);
  const quiet = quotes.filter((q) => q.score < threshold);
  const itemSymbols = new Set(quotes.map((q) => q.symbol));
  const allUnavailable = quotes.length > 0 && quotes.every((q) => q.quality.kind === "unavailable");
  const staleFeed = quotes.length > 0 && !allUnavailable && quotes.every((q) => q.quality.kind === "stale" || q.quality.kind === "unavailable");
  const drawerQ = quotes.find((x) => x.symbol === drawer);
  const drawerEvents = drawer ? events.filter((e) => e.symbol === drawer) : [];
  const visibleQuiet = filter === "attention" ? [] : quiet;
  const total = quotes.length;

  const bdTitle = (q: Quote) =>
    `Price surprise ${q.comp.surprise}/40 · Volume ${q.comp.volume}/25 · Range ${q.comp.threshold}/20 · Reversal ${q.comp.reversal}/15 — open details`;

  // Badge reflects the configured provider AND the actual quote sources, so
  // stored simulated observations are never presented as real market data.
  const quoteSources = new Set(quotes.map((q) => q.source));
  const modeLabel = mode === "demo-simulated" || demoFrozen
    ? "Demo · simulated"
    : mode === "real-provider" && quoteSources.size > 0 && ![...quoteSources].every((s) => s === "finnhub")
      ? "Simulated observations"
      : mode === "real-provider" ? "Real provider · delayed" : "Simulated feed";

  return (
    <main className="mx-auto max-w-[1120px] px-4 py-5">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/80 pb-3">
        <div className="flex items-center gap-2">
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" className="shrink-0">
            <rect x="1" y="1" width="18" height="18" rx="4" fill="none" stroke="#a78bfa" strokeWidth="1.5" />
            <polyline points="4.5,12 8,12 10,7 12,14 13.5,10 15.5,10" fill="none" stroke="#a78bfa" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div>
            <h1 className="text-[15px] font-bold leading-tight tracking-tight">Smart Watchlist</h1>
            <p className="text-[11px] leading-tight text-zinc-500">What changed. What matters.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${demoFrozen ? "bg-amber-500/15 text-amber-300" : modeLabel.startsWith("Real provider") ? "bg-emerald-500/10 text-emerald-300" : "bg-zinc-800 text-zinc-300"}`}>
            {modeLabel}
          </span>
          <button onClick={() => setHowOpen(true)} className="rounded-lg px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-500">How it works</button>
          {!demoFrozen && (
            <button onClick={() => demoAction("start")} disabled={demoBusy} className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-500 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-zinc-500">
              {demoBusy ? "Loading…" : "▶ Demo"}
            </button>
          )}
        </div>
      </header>

      {demoFrozen && (
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-xs text-amber-200/90" role="status">
          <p className="font-medium">Demo mode · Simulated market scenarios</p>
          <p className="mt-0.5 text-amber-200/70">A simulated price spike occurred. Advance to see what happens after it reverses.{demoHint ? ` ${demoHint}` : ""} Your live watchlist is untouched.</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button onClick={() => demoAction("advance")} disabled={demoBusy} className="rounded-lg bg-amber-200/90 px-2.5 py-1 text-xs font-semibold text-zinc-900 hover:bg-amber-200 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-amber-400">Next scenario</button>
            <button onClick={() => demoAction("reset")} disabled={demoBusy} className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-500 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-zinc-500">Reset</button>
            <button onClick={exitDemo} className="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-500">Exit demo</button>
          </div>
          <details className="mt-1.5">
            <summary className="cursor-pointer text-[11px] text-amber-200/70 underline-offset-2 hover:underline focus:outline-none focus:ring-2 focus:ring-amber-400">Demo test controls</summary>
            <p className="mt-1 text-[11px] text-amber-200/60">While a briefing is open, inject an event, then acknowledge the earlier briefing — the new event stays unread.</p>
            <button onClick={() => demoAction("inject")} disabled={demoBusy} className="mt-1 rounded-lg border border-amber-500/40 px-2.5 py-1 text-xs text-amber-200 hover:border-amber-400 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-amber-400">Inject event now</button>
          </details>
        </div>
      )}

      {loadError && <p className="mt-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-1.5 text-xs text-red-300" role="alert">{loadError} <button onClick={() => wlId && loadBriefing(wlId)} className="underline">Retry</button></p>}

      {!onboardOff && tracking === false && !loading && (
        <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="flex items-start justify-between gap-2">
            <p className="text-[13px] font-medium text-zinc-200">A watchlist that filters the noise.</p>
            <button aria-label="Dismiss onboarding" onClick={() => { setOnboardOff(true); localStorage.setItem("sw_onboard", "off"); }} className="rounded text-zinc-500 hover:text-zinc-300 focus:outline-none focus:ring-2 focus:ring-zinc-500">✕</button>
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">
            We compare every stock against its own recent behavior and preserve unusual moves as reviewable evidence.
          </p>
          <p className="mt-1 font-mono text-[11px] text-zinc-500">Watch → Detect → Explain</p>
        </div>
      )}

      <p className="mt-3 text-[11px] text-zinc-500">
        <span className="font-medium text-zinc-300">{wlName || "…"}</span>
        {reviewedAt ? (
          <> · Last reviewed <span title={new Date(reviewedAt).toLocaleString()}>{timeAgo(reviewedAt)}</span></>
        ) : tracking ? " · Not yet reviewed" : null}
        {market.label ? <> · <span title={market.note}>{market.open ? "Market open" : "Market closed"} (approx. hours)</span></> : null}
        <button onClick={() => wlId && loadBriefing(wlId)} disabled={refreshing || !wlId} aria-label="Refresh briefing"
          className="ml-2 rounded px-1.5 py-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-zinc-500">
          <span className={`inline-block ${refreshing ? "animate-spin" : ""}`} aria-hidden="true">↻</span> {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </p>

      <section className="mt-1.5 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3" aria-label="Since your last review" aria-live="polite">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[13px] font-semibold text-zinc-200">
            Since your last review{!loading && tracking && unreadTotal > 0 ? ` · ${unreadTotal} unread` : ""}
          </h2>
          {!loading && tracking && visibleEvents.length > 0 && (
            <button onClick={acknowledge} disabled={acking} className="rounded-lg bg-zinc-100 px-2.5 py-1 text-xs font-semibold text-zinc-900 hover:bg-white disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-zinc-400">
              {acking ? "Reviewing…" : `Mark displayed changes as reviewed (${visibleEvents.length})`}
            </button>
          )}
        </div>
        {!loading && tracking && (reviewedAt ? (
          <p className="mt-0.5 text-[11px] text-zinc-500">Compared with your review <span title={new Date(reviewedAt).toLocaleString()}>{timeAgo(reviewedAt)}</span></p>
        ) : trackingSince ? (
          <p className="mt-0.5 text-[11px] text-zinc-500">Tracking started <span title={new Date(trackingSince).toLocaleString()}>{timeAgo(trackingSince)}</span></p>
        ) : null)}
        {loading ? (
          <div className="mt-2 space-y-1.5"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-2/3" /></div>
        ) : tracking === false ? (
          <div className="mt-1">
            <p className="text-[13px] leading-relaxed text-zinc-400">
              Start tracking from this point — meaningful changes will appear here for your next visit.
            </p>
            <button onClick={startTrackingNow} disabled={starting} className="mt-2 rounded-lg bg-zinc-100 px-3 py-1.5 text-[13px] font-semibold text-zinc-900 hover:bg-white disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-zinc-400">
              {starting ? "Starting…" : "Start tracking from here"}
            </button>
          </div>
        ) : visibleEvents.length > 0 ? (
          <>
            <ul className="mt-1.5 space-y-2">
              {visibleEvents.map((e) => {
                const base = e.baseline_price;
                const net = base && base > 0 ? ((e.observed_price - base) / base) * 100 : null;
                return (
                  <li key={e.id} className="rounded-lg border border-zinc-800/70 p-2">
                    <div className="flex items-baseline justify-between gap-2 text-[13px]">
                      <span className="font-mono font-semibold text-zinc-100">{e.symbol}{e.company ? <span className="ml-1.5 font-sans text-xs font-normal text-zinc-500">{e.company}</span> : null}</span>
                      <span className="shrink-0 text-[11px] text-zinc-500" title={new Date(e.occurred_at).toLocaleString()}>{timeAgo(e.occurred_at)}</span>
                    </div>
                    <div className="mt-1"><TierTag score={e.score} /></div>
                    <p className="mt-1 text-[13px] text-zinc-300">{e.summary}</p>
                    <p className="tnum mt-0.5 text-[11px] text-zinc-500">
                      Observed {fmtMoney(e.symbol, e.observed_price)}
                      {base ? ` vs baseline ${fmtMoney(e.symbol, base)}` : " (baseline unavailable)"}
                      {net != null ? ` (${net >= 0 ? "+" : ""}${net.toFixed(1)}% excursion)` : ""}
                      {" · "}{e.source === "demo" ? "simulated" : e.source}
                    </p>
                    <button onClick={() => openDrawer(e.symbol)} className="mt-1 text-xs text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline focus:outline-none focus:ring-2 focus:ring-zinc-500">
                      View evidence
                    </button>
                  </li>
                );
              })}
            </ul>
            {hiddenBySens > 0 && (
              <p className="mt-1.5 text-[11px] text-zinc-500">
                {hiddenBySens} more below your sensitivity ({sens}, ≥{threshold}). The server stores every event ≥{SERVER_STORE_THRESHOLD} — switch to Sensitive to display them.
              </p>
            )}
            {unreadTotal > events.length && (
              <p className="mt-1 text-[11px] text-zinc-500">Showing {events.length} of {unreadTotal} unread — reviewing here acknowledges only what is displayed.</p>
            )}
            {ackError && <p className="mt-1.5 text-xs text-red-300" role="alert">{ackError} <button onClick={acknowledge} className="underline">Retry</button></p>}
          </>
        ) : (
          <div className="mt-1 text-[13px] leading-relaxed text-zinc-400">
            {allUnavailable ? (
              <p>Feed unavailable — showing the last accepted quotes below. Treat prices as outdated until the feed recovers.</p>
            ) : staleFeed ? (
              <p>No new signals detected in the available data.<br /><span className="text-[12px] text-zinc-500">Some quotes are stale, so recent changes may be missing.</span></p>
            ) : events.length === 0 && unreadTotal === 0 ? (
              <p>No significant changes observed since your last review.</p>
            ) : (
              <p>You&apos;re caught up.</p>
            )}
          </div>
        )}
        {coverage && coverage.incomplete && (
          <p className="mt-1.5 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-2 py-1 text-[11px] text-amber-200/70" role="note">
            Coverage gap: {coverage.note}
          </p>
        )}
      </section>

      <div className="relative mt-3">
        <label htmlFor="stock-search" className="mb-1 block text-xs font-medium text-zinc-400">Search stocks</label>
        <form onSubmit={(e) => { e.preventDefault(); if (activeIdx >= 0 && suggest[activeIdx]) addSymbol(suggest[activeIdx].symbol); else addSymbol(input); }} className="flex gap-2">
          <div className="relative flex-1">
            <input id="stock-search" ref={searchInputRef} value={input} onChange={(e) => onSearchChange(e.target.value)} placeholder="Ticker or company — e.g. Nvid…"
              role="combobox" aria-expanded={suggestOpen} aria-controls="ticker-suggest" aria-autocomplete="list"
              onFocus={() => { if (suggest.length || searchError) setSuggestOpen(true); }}
              onBlur={() => setTimeout(() => setSuggestOpen(false), 120)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, suggest.length - 1)); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, -1)); }
              }}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-[13px] outline-none placeholder:text-zinc-600 focus:border-zinc-600 focus:ring-2 focus:ring-zinc-700" />
            {suggestOpen && input.trim() && (
              <ul id="ticker-suggest" role="listbox" aria-label="Matching stocks" className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
                {searchBusy ? (
                  <li className="px-3 py-2 text-[13px] text-zinc-500">Searching…</li>
                ) : searchError ? (
                  <li className="px-3 py-2 text-[13px] text-zinc-500">{searchError}</li>
                ) : suggest.length === 0 ? (
                  <li className="px-3 py-2 text-[13px] text-zinc-500">No matching symbols</li>
                ) : suggest.map((s, i) => (
                  <li key={s.symbol} role="option" aria-selected={i === activeIdx}>
                    <button type="button" onMouseDown={() => addSymbol(s.symbol)}
                      onMouseEnter={() => setActiveIdx(i)}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] ${i === activeIdx ? "bg-zinc-800" : ""}`}>
                      <span className="min-w-0"><span className="font-mono font-semibold text-zinc-100">{s.symbol}</span>
                        <span className="ml-2 truncate text-xs text-zinc-400">{s.name}</span>
                        {s.exchange ? <span className="ml-1.5 font-mono text-[10px] text-zinc-600">{s.exchange}</span> : null}</span>
                      {itemSymbols.has(s.symbol) ? <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">Added</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button disabled={addBusy} className="rounded-lg bg-zinc-100 px-3.5 py-1.5 text-[13px] font-semibold text-zinc-900 hover:bg-white disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-zinc-400">
            {addBusy ? "Adding…" : "Add"}
          </button>
        </form>
        {err && <p className="mt-1.5 text-[13px] text-red-300" role="alert">{err}</p>}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[13px]" role="group" aria-label="List filter">
          <span className="mr-1.5 text-zinc-500">Show:</span>
          {(["all", "attention"] as const).map((f) => (
            <button key={f} onClick={() => { setFilter(f); sessionStorage.setItem("sw_filter", f); }}
              aria-pressed={filter === f}
              className={`rounded-lg px-2.5 py-1 text-xs ${filter === f ? "bg-zinc-100 font-semibold text-zinc-900" : "text-zinc-400 hover:text-zinc-200"} focus:outline-none focus:ring-2 focus:ring-zinc-500`}>
              {f === "all" ? "All" : "Needs attention"}
            </button>
          ))}
        </div>
        <div className="text-xs" role="group" aria-label="Attention sensitivity">
          <label htmlFor="sens-select" className="mr-1.5 text-zinc-500" title="Sensitivity filters this display only — signals are generated server-side at scores ≥55">Sensitivity:</label>
          <select id="sens-select" value={sens} onChange={(e) => { const k = e.target.value as SensKey; setSens(k); localStorage.setItem("sw_sens", k); }}
            title="Display filter only — the server stores every event ≥55 regardless"
            className="rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs capitalize text-zinc-300 focus:border-zinc-600 focus:outline-none focus:ring-2 focus:ring-zinc-500">
            {(Object.keys(SENS) as SensKey[]).map((k) => (
              <option key={k} value={k} className="capitalize">{k} (≥{SENS[k]})</option>
            ))}
          </select>
        </div>
      </div>
      <p className="mt-1 text-[11px] text-zinc-600">Sensitivity filters this display only — signals are generated server-side at scores ≥{SERVER_STORE_THRESHOLD}.</p>

      {loading ? (
        <div className="mt-3 space-y-2"><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /><Skeleton className="h-8 w-full" /></div>
      ) : total === 0 ? (
        <div className="mt-3 rounded-xl border border-dashed border-zinc-800 p-8 text-center">
          <p className="text-sm font-medium">Add your first stock to start tracking.</p>
          <div className="mt-3 flex flex-wrap justify-center gap-1.5">
            {["AAPL", "NVDA", "MSFT", "INFY", "TSLA"].map((s) => (
              <button key={s} onClick={() => addSymbol(s)} className="rounded-lg border border-zinc-700 px-2.5 py-1 font-mono text-xs text-zinc-300 hover:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-500">+ {s}</button>
            ))}
          </div>
        </div>
      ) : (
        <>
          {attn.length > 0 ? (
            <section className="mt-3" aria-label="Needs attention">
              <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Needs attention ({attn.length})</h2>
              <div className="grid gap-2 sm:grid-cols-2">
                {attn.map((q) => {
                  const up = (q.dayChangePct ?? 0) >= 0;
                  const t = tierOf(q.score);
                  const sr = q.sinceReview?.pct ?? null;
                  const d = directionOf(sr);
                  return (
                    <article key={q.symbol}
                      className={`rounded-xl border p-3 transition-colors duration-150 ${t === "high" ? "border-red-500/30 bg-red-500/[0.04]" : "border-amber-500/25 bg-amber-500/[0.04]"}`}>
                      <div className="flex items-center justify-between gap-2">
                        <p className="min-w-0 truncate text-sm"><span className="font-mono font-bold">{q.symbol}</span>{q.company ? <span className="ml-1.5 text-xs font-normal text-zinc-500">{q.company}</span> : null}</p>
                        <button onClick={() => remove(q.symbol)} disabled={removing === q.symbol} aria-label={`Remove ${q.symbol} from watchlist`} className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-zinc-500">✕</button>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <span title={bdTitle(q)}><TierTag score={q.score} /></span>
                        <span className={`font-mono text-lg font-bold tabular-nums ${d === "flat" ? "text-zinc-300" : up ? "text-emerald-300" : "text-red-300"}`}
                          title={q.sinceReview ? `Since review baseline (${timeAgo(q.sinceReview.baselineAsOf)})` : "No reviewed baseline yet"}>
                          {sr == null ? "N/A" : `${d === "down" ? "−" : d === "up" ? "+" : ""}${Math.abs(sr).toFixed(1)}%`}
                        </span>
                        <span className="text-[10px] text-zinc-500">since review</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs leading-snug text-zinc-300">{describe(q)}</p>
                      {q.chips.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {q.chips.map((c) => <span key={c} className="rounded bg-zinc-800/80 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">{c}</span>)}
                        </div>
                      )}
                      {q.missing.length > 0 && (
                        <p className="mt-1 text-[10px] text-zinc-600">Unavailable: {q.missing.map((m) => missingLabel(m)).join(" · ")}</p>
                      )}
                      <div className="mt-1.5 flex items-end justify-between gap-2">
                        <span className="font-mono text-xs tabular-nums text-zinc-500">{fmtMoney(q.symbol, q.price)}</span>
                        <Spark data={q.sparkline} up={up} baseline={q.prevClose ?? undefined} markEvent={q.score >= threshold} label />
                      </div>
                      <button onClick={() => openDrawer(q.symbol)} className="mt-1.5 text-xs text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline focus:outline-none focus:ring-2 focus:ring-zinc-500">
                        View evidence
                      </button>
                    </article>
                  );
                })}
              </div>
            </section>
          ) : filter === "all" && !(staleFeed || coverage?.incomplete) && (
            <p className="mt-3 rounded-xl border border-zinc-800/70 bg-zinc-900/30 p-3 text-[13px] text-zinc-400">
              <span className="font-medium text-zinc-200">All quiet.</span> None of your {total} stock{total === 1 ? " is" : "s are"} behaving unusually right now.
            </p>
          )}
          {!loading && total > 0 && filter === "attention" && attn.length === 0 && (
            <section className="mt-3 rounded-xl border border-zinc-800/70 bg-zinc-900/30 p-3" aria-label="No matching stocks">
              <p className="text-[13px] text-zinc-300">No stocks match this filter.</p>
              <p className="mt-0.5 text-xs text-zinc-500">
                {staleFeed || coverage?.incomplete
                  ? "Some quotes are stale. New signals may appear after data updates."
                  : "No significant signals were detected in the available observations."}
              </p>
              <button onClick={() => { setFilter("all"); sessionStorage.setItem("sw_filter", "all"); }} className="mt-1.5 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-500">
                Show all stocks
              </button>
            </section>
          )}
          {!loading && total > 0 && filter === "all" && attn.length === 0 && visibleEvents.length === 0 && (staleFeed || coverage?.incomplete) && (
            <p className="mt-3 rounded-xl border border-zinc-800/70 bg-zinc-900/30 p-3 text-[13px] text-zinc-400">
              No new signals detected in the available data. <span className="text-xs text-zinc-500">Some quotes are stale, so recent changes may be missing.</span>
            </p>
          )}

          {visibleQuiet.length > 0 && (
            <section className="mt-3" aria-label="Normal">
              <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Normal ({visibleQuiet.length})</h2>
              <div className="mb-1 hidden grid-cols-[minmax(0,1.7fr)_104px_104px_128px_auto] items-center gap-3 px-3 text-[10px] font-medium uppercase tracking-wider text-zinc-600 sm:grid" aria-hidden="true">
                <span>Stock</span><span className="text-right">Price</span><span className="text-right">Since review</span><span>Status</span><span />
              </div>
              <ul className="divide-y divide-zinc-800/70 rounded-xl border border-zinc-800 bg-zinc-900/40">
                {visibleQuiet.map((q) => (
                  <QuietRow key={q.symbol} q={q} onOpen={openDrawer} onRemove={remove} removing={removing === q.symbol} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <footer className="mt-6 border-t border-zinc-800/70 pt-2.5 text-[11px] leading-relaxed text-zinc-600">
        <p>{demoFrozen ? "Simulated data · demo scenario" : quoteSources.size > 0 && [...quoteSources].every((s) => s === "finnhub") ? "Finnhub data · delayed ~60s (unverified)" : quoteSources.size > 0 && [...quoteSources].some((s) => s === "finnhub") ? "Mixed provider and simulated observations" : "Simulated data"}</p>
      </footer>

      {drawer && drawerQ && (() => {
        const up = (drawerQ.dayChangePct ?? 0) >= 0;
        const q = drawerQ.quality;
        return (
        <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/60 sm:items-stretch sm:justify-end" onClick={() => setDrawer(null)}>
          <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={`${drawerQ.symbol} details`}
            className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-zinc-950 p-4 sm:max-h-none sm:max-w-sm sm:rounded-none" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-[15px]"><span className="font-semibold text-zinc-100">{drawerQ.company ?? drawerQ.symbol}</span> <span className="font-mono text-xs text-zinc-500">{drawerQ.symbol}</span></h3>
              <button data-autofocus onClick={() => setDrawer(null)} aria-label="Close details" className="rounded px-1.5 py-0.5 text-zinc-500 hover:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-zinc-500">✕</button>
            </div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <p className="font-mono text-xl tabular-nums">{fmtMoney(drawerQ.symbol, drawerQ.price)}</p>
              <p className={`font-mono text-[13px] tabular-nums ${(() => { const d = directionOf(drawerQ.sinceReview?.pct ?? null); return d === "flat" ? "text-zinc-400" : d === "up" ? "text-emerald-300" : "text-red-300"; })()}`}
                title={drawerQ.sinceReview ? `Baseline from ${new Date(drawerQ.sinceReview.baselineAsOf).toLocaleString()}` : undefined}>
                {drawerQ.sinceReview ? `${drawerQ.sinceReview.pct >= 0 ? "+" : "−"}${Math.abs(drawerQ.sinceReview.pct).toFixed(2)}% since review` : "Not available — review to set a baseline"}
              </p>
            </div>
            <p className={`mt-1.5 font-mono text-xs font-bold uppercase tracking-wider ${tierOf(drawerQ.score) === "high" ? "text-red-300" : tierOf(drawerQ.score) === "watch" ? "text-amber-300" : "text-zinc-500"}`}>
              {TIER_LABEL[tierOf(drawerQ.score)]} · {drawerQ.score}
            </p>
            <h4 className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Why it matters</h4>
            <p className="text-[13px] leading-relaxed text-zinc-300">
              <span className="text-zinc-500">Recent price action: </span>{describe(drawerQ)}
            </p>
            {(drawerQ.missing.includes("baseline") || drawerQ.missing.includes("volatility")) && (
              <p className="mt-1 text-xs text-zinc-500">Learning this stock&apos;s recent behavior — some inputs aren&apos;t available yet.</p>
            )}
            {drawerEvents.length > 0 && (
              <div className="mt-2 rounded-lg border border-zinc-800 p-2 text-xs text-zinc-400">
                <p className="font-medium text-zinc-300">Latest unread evidence</p>
                <p className="mt-0.5">{drawerEvents[0].summary}</p>
                <p className="tnum mt-0.5 text-[11px] text-zinc-500">
                  Observed {fmtMoney(drawerQ.symbol, drawerEvents[0].observed_price)} at {new Date(drawerEvents[0].occurred_at).toLocaleString()}
                  {drawerEvents[0].baseline_price ? ` vs baseline ${fmtMoney(drawerQ.symbol, drawerEvents[0].baseline_price)}` : ""}
                </p>
              </div>
            )}
            {drawerQ.chips.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {drawerQ.chips.map((c) => <span key={c} className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">{c}</span>)}
              </div>
            )}
            <h4 className="mb-1 mt-4 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Recent samples</h4>
            <Spark data={[...drawerQ.sparkline]} up={up} baseline={drawerQ.prevClose ?? undefined} markEvent={drawerQ.score >= threshold} />
            <details className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
              <summary className="cursor-pointer text-xs font-medium text-zinc-300 focus:outline-none focus:ring-2 focus:ring-zinc-500">Score breakdown</summary>
              <div className="mt-2 space-y-2">
                <Bar label="Price surprise (vs own past moves)" pts={drawerQ.comp.surprise} max={40} />
                <Bar label="Volume anomaly" pts={drawerQ.comp.volume} max={25} />
                <Bar label="Observed-range event" pts={drawerQ.comp.threshold} max={20} />
                <Bar label="Trend reversal" pts={drawerQ.comp.reversal} max={15} />
              </div>
              {drawerQ.missing.length > 0 && (
                <p className="mt-2 text-xs text-zinc-500">Unavailable inputs: {drawerQ.missing.map((m) => missingLabel(m)).join(" · ")} — scored zero without reweighting.</p>
              )}
            </details>
            <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5 text-xs" aria-label="Data quality">
              <p className="capitalize text-zinc-400">{q.kind} · {q.detail}</p>
              <p className="mt-0.5 text-zinc-500">Source: {drawerQ.source === "demo" ? "simulated (demo)" : drawerQ.source}{drawerQ.asOf ? ` · observed ${timeAgo(drawerQ.asOf)}` : ""}
                {drawerQ.low52w != null ? ` · observed range ${fmtMoney(drawerQ.symbol, drawerQ.low52w)}–${fmtMoney(drawerQ.symbol, drawerQ.high52w ?? drawerQ.low52w)}` : ""}</p>
            </div>
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline focus:outline-none focus:ring-2 focus:ring-zinc-500">
                View observations ({history.length})
              </summary>
              <ul className="tnum mt-1.5 max-h-48 space-y-1 overflow-auto font-mono text-[13px]">
                {history.map((h, i) => (
                  <li key={i} className="flex justify-between text-zinc-400">
                    <span>{fmtMoney(drawerQ.symbol, Number(h.price))}</span>
                    <span className="text-[11px]">{new Date(h.asOf).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        </div>
        );
      })()}

      {howOpen && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 p-4" onClick={() => setHowOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="How Attention Score works" className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold">How Attention Score Works</h3>
              <button autoFocus onClick={() => setHowOpen(false)} aria-label="Close methodology" className="rounded text-zinc-500 hover:text-zinc-200 focus:outline-none focus:ring-2 focus:ring-zinc-500">✕</button>
            </div>
            <p className="mt-1.5 text-[13px] text-zinc-400">We compare each stock against its own accepted observations — a heuristic for prioritization, not a prediction or recommendation.</p>
            <p className="mt-1 text-[13px] font-medium text-zinc-200">A 1% move means nothing without context.</p>
            <div className="mt-2.5 flex h-2.5 overflow-hidden rounded-full" aria-hidden="true">
              <div className="bg-red-400/80" style={{ width: "40%" }} />
              <div className="bg-amber-400/80" style={{ width: "25%" }} />
              <div className="bg-sky-400/70" style={{ width: "20%" }} />
              <div className="bg-violet-400/70" style={{ width: "15%" }} />
            </div>
            <ul className="mt-2 space-y-1.5 text-[13px] text-zinc-300">
              <li><span className="font-mono text-zinc-100">40 pts · Price surprise</span><br /><span className="text-xs text-zinc-500">Move vs volatility of past moves (needs 5+ samples)</span></li>
              <li><span className="font-mono text-zinc-100">25 pts · Volume anomaly</span><br /><span className="text-xs text-zinc-500">Volume vs recent-sample average (needs 3+ samples)</span></li>
              <li><span className="font-mono text-zinc-100">20 pts · Observed-range events</span><br /><span className="text-xs text-zinc-500">New high/low of the retained observation window — not a 52-week claim</span></li>
              <li><span className="font-mono text-zinc-100">15 pts · Trend reversal</span><br /><span className="text-xs text-zinc-500">Short vs medium sample windows (needs 7 closes)</span></li>
            </ul>
            <p className="mt-2.5 text-[13px] text-zinc-300"><span className="font-mono text-amber-300">55+ Worth Watching</span> · <span className="font-mono text-red-300">80+ High Attention</span></p>
            <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">Missing inputs score zero without reweighting. Freshness is shown separately and never inflates a score. No new signals fire when the market is closed.</p>
            <p className="mt-1.5 border-t border-zinc-800/70 pt-1.5 text-[11px] leading-relaxed text-zinc-600">Observations are sampled about every 60 seconds by one shared scheduler. Quotes are kept 7 days, events 30 days — older gaps are labelled as coverage gaps. Market open/closed is a weekday ET approximation; holidays and early closes aren&apos;t modelled.</p>
          </div>
        </div>
      )}

      <div className="pointer-events-none fixed bottom-4 left-1/2 z-30 flex -translate-x-1/2 flex-col items-center gap-1.5" aria-live="polite">
        {toasts.map((t) => (
          <p key={t.id} className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 shadow-xl">{t.msg}</p>
        ))}
      </div>
    </main>
  );
}
