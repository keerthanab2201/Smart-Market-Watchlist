# Smart Market Watchlist

> **We preserve what you missed and explain why it matters.**

A watchlist that answers: **what meaningfully changed since my last review, and why should I care?** The return briefing — not the price grid — is the product.

## Run it

```bash
cd smart-watchlist
npm install
npm run dev        # http://localhost:3000
npm test           # fast unit + integration suite (43 tests)
npm run test:http  # HTTP ownership/auth checks (needs `npm run build` first)
npm run build      # production build
```

Zero-key demo path: no credentials needed. Storage is SQLite (`.data/watchlist.sqlite`, created on boot). Copy `.env.example` to `.env` only if you use a real provider key or ingest secret.

## Architecture

```
provider (simulation | finnhub) → validated observations
        → shared in-process ingestion (single-flight, 60s, per-symbol isolation)
        → SQLite: quotes / incremental baselines / persisted scores / immutable events
        → per-user briefing API (explicit tracking + review tokens, one snapshot)
        → briefing-first UI
```

The scheduler starts in `src/instrumentation.ts` at server boot and runs
without visitors. Deployment requirement: **one instance with a persistent
disk** for `.data/`. Multiple instances would each schedule against separate
SQLite files — that topology needs PostgreSQL instead (the schema maps 1:1).

## What "meaningful" means (score v2, heuristic — not advice)

One canonical function (`scoreQuote` in `src/lib/score.ts`, version 2) scores
every observation; the UI displays the **persisted** result stored with that
exact quote and never recalculates history against newer baselines. Weights:
surprise 40, volume 25, observed-range 20, reversal 15. Server stores events ≥ 55.

Honesty rules, all visible in the UI:

- Baselines are computed from **actual accepted observations** (Welford
  mean/variance, incremental volume average, retained min/max) **before** the
  observation being scored; quote, baseline update, score, and event commit
  atomically after the provider request completes.
- Minimum evidence is enforced: 5+ past moves, 3+ volume samples,
  5+ observations for range, 7 closes for trend. Missing inputs score **zero
  without reweighting** and are listed, never hidden.
- Statistics describe **observations since tracking began** (ingest samples
  roughly every 60s; gaps widen intervals — volatility uses consecutive
  accepted observations regardless of gap). No 52-week, 20-day, σ, or
  confidence claims. Ranges are the **retained observation window**; volume is
  compared to the **recent-sample average**; freshness is a separate quality
  badge and never inflates a score.
- Session-vs-previous-close change appears only when the provider supplies a
  previous close; otherwise the UI shows change **since your last review** or
  "Not available". Unknown volume stays `null`, never zero.
- US market open/closed is a weekday 9:30–16:00 ET **approximation** —
  holidays and early closes are not modeled, and the UI says so.

## Review semantics

- **Explicit tracking:** first visit offers "Start tracking from here". Nothing
  before tracking began is presented as missed.
- **One briefing snapshot:** quotes, events, baselines, and the review token
  come from a single request, so acknowledgement commits exactly what was
  displayed. Late arrivals stay unread, undisplayed events are never skipped,
  repeats report only newly-reviewed items, old tabs can't regress baselines,
  and baselines from an earlier membership period are never restored (all
  transactional).
- **Reversals preserved:** events store immutable evidence (observed vs
  baseline price, components, source, version). A spike that later reverses
  stays visible alongside the net change.
- **Dedupe:** same-condition repeats suppressed for 60 minutes unless the
  score escalates ≥ 15 or the direction changes.
- **Membership:** adding a stock starts its tracking at addition (pre-addition
  events are filtered in SQL before sorting/limiting); removing resets its
  baseline, so re-adding starts fresh.

## Demo mode (isolated, deterministic)

Demo data lives in a per-user `demo:<uid>` namespace plus an owned demo
watchlist — never touching live quotes, statistics, events, or other users.
Controls: **Reset demo** (flat baselines, tracking on, no events),
**Advance scenario** (appends the next scripted observation; never deletes
evidence), **Inject event now** (a fresh event for ack-race demos),
**Exit demo** (back to the live watchlist). Script: baseline $100 → spike
$108 (event) → return $101 (≈+1% since review, spike preserved) → NVDA
event → quiet tick. All timestamps injectable for tests.

## Data modes (always labelled)

Simulated feed · Finnhub · Delayed · Stale · Unavailable · Demo (isolated per-user namespace). Simulated output is
never presented as live. Switching live sources resets statistics and records
the switch, so windows stay homogeneous.

### Simulation → provider transition

Each source has its own ordering stream: a valid earlier-dated provider
session quote supersedes newer simulated rows for display, while out-of-order
observations within one stream stay rejected. On first real acceptance the
symbol's simulated-derived statistics and simulated-era review baselines are
dropped (simulated quotes/events stay preserved), a transition is recorded,
and the UI asks for a new review baseline. Old briefing tokens cannot restore
previous-generation baselines. Pre-transition simulated events remain visible
under "Earlier simulated signals", separate from real unread events.

A configured key is required for live fetching; the running server's key and
the `.env` value must agree (a stale `.env` takes effect only after restart).
Without a working key the app keeps serving last-known-good quotes with
explicit update-failure labels — never silently simulated prices.

## Known limitations

- Finnhub adapter implemented but **live integration not verified** (no key in
  this environment); `/quote` carries no volume, so provider volume is
  honestly unknown.
- Single-process SQLite + in-process scheduler (see deployment note above).
- Quote retention 7 days, events 30 days — a coverage warning appears only
  when pruning actually overlaps the tracking window.
- No corporate-action (split/dividend) adjustment; holidays/early closes
  approximated; observation gaps documented above.
- Anonymous device identity is same-browser only; cross-device deferred.

## Three-minute demo script

1. Open the app → "Start tracking from here".
2. **▶ Demo** → Reset, then **Advance scenario**: DEMO spikes $100 → $108.
3. **Advance** again → DEMO returns to $101: briefing keeps the spike and
   shows ≈+1% since review.
4. **Inject event now** → refetch the briefing → acknowledge the earlier
   briefing → only the injected event remains unread.
5. Kill the feed/one symbol fails → last-known-good quotes stay visible with
   true timestamps and stale labels.


### Provenance repair and runtime verification (September 6, 2026)

Run one persistent server against durable SQLite. Do not run development and production simultaneously against the same database. Multiple instances require PostgreSQL and coordinated ingestion; the in-process scheduler is not a distributed scheduler.

Review baselines now store the source and membership ID. Unknown legacy provenance is not used for returns. Adding a stock creates a new membership and requires an explicit review baseline; shared quotes remain. Briefings and history select the same displayed source. Refresh reads stored observations; ingestion is performed by the approximately 60-second scheduler or the authenticated POST /api/ingest.

For an explicit repair of legacy duplicates and derived statistics, stop the app, set SW_DB_PATH if using a custom database, and run from smart-watchlist:

```powershell
node --experimental-strip-types --import ../tests/register.mjs scripts/repair-provenance.mjs
```

The repair creates a complete SQLite VACUUM backup before mutation, reports removed duplicate counts, preserves old simulation observations, normalizes legacy Finnhub volume zeroes to null, and rebuilds scores/statistics from the active source only. Existing event evidence is not regenerated. The database repair is explicit, not a startup cleanup.

GET /api/diag reports PID, process working directory, mode, database path, provider selection, scheduler health and per-symbol HTTP outcomes without credentials. Production diagnostics and manual ingestion require x-ingest-secret matching INGEST_SECRET. SW_DISABLE_SCHEDULER=1 is reserved for isolated test runs. Finnhub credentials are sent in the provider header, never a logged URL.

Observed real retrieval: HTTP 200 for TSLA at $354.08, provider timestamp 2026-09-04T20:00:00Z; a repeat was deduplicated. This verifies retrieval, not a claim of exchange-level real-time latency. Session status uses a weekday ET approximation and does not model holidays or early closes.
