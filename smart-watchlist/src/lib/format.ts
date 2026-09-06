import { currencyFor } from "./companies";

export function fmtMoney(symbol: string, value: number): string {
  const currency = currencyFor(symbol);
  try {
    return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
      style: "currency", currency, maximumFractionDigits: value < 1000 ? 2 : 0,
    }).format(value);
  } catch {
    return `${currency === "INR" ? "₹" : "$"}${value.toLocaleString()}`;
  }
}

/** Session return vs previous close, or null when the source has no session data. */
export function fmtSessionChange(prevClose: number | null, price: number): string | null {
  if (prevClose == null || !(prevClose > 0) || !(price > 0)) return null;
  const pct = ((price - prevClose) / prevClose) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% vs prev. session`;
}

/** Direction of a percentage for coloring: colors must follow the comparison shown. */
export function directionOf(pct: number | null): "up" | "down" | "flat" {
  if (pct == null) return "flat";
  if (pct > 0.005) return "up";
  if (pct < -0.005) return "down";
  return "flat";
}

export function timeAgo(iso: string, nowMs = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export type QuoteKind = "simulated" | "live" | "delayed" | "stale" | "unavailable";

/**
 * Quote status from observation age, session state, and source — pure and
 * testable. "Last session" is claimed only for recent observations while the
 * market is closed; older quotes are stale regardless of session.
 */
export function describeQuoteStatus(
  asOf: string | null, source: string, marketOpen: boolean, nowMs = Date.now(),
): { kind: QuoteKind; detail: string } {
  if (!asOf) return { kind: "unavailable", detail: "Quote unavailable" };
  const ageS = Math.max(0, (nowMs - new Date(asOf).getTime()) / 1000);
  const ago = ageS < 90 ? "just now" : `${Math.round(ageS / 60)}m ago`;
  const sim = source === "simulated" || source === "demo" || source === "legacy";
  if (!sim && !marketOpen) {
    const parts = new Intl.DateTimeFormat("en-CA", {timeZone:"America/New_York", year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(nowMs));
    const part = (name: string) => parts.find(p => p.type === name)!.value;
    const day = new Date(Date.UTC(Number(part("year")), Number(part("month"))-1, Number(part("day"))));
    if (Number(part("hour")) < 16) day.setUTCDate(day.getUTCDate()-1);
    while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate()-1);
    const observed = new Intl.DateTimeFormat("en-CA", {timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(asOf));
    if (observed === day.toISOString().slice(0,10)) return {kind:"delayed",detail:"Last session · US market closed (ET; weekday schedule approximation)"};
  }
  if (ageS > 600) {
    return {
      kind: "stale",
      detail: `${sim ? "Simulated data" : "Last update"} ${ago}${marketOpen ? "" : " (market closed)"}`,
    };
  }
  if (sim) return { kind: "simulated", detail: `Simulated data · updated ${ago}` };
  if (!marketOpen) {
    // Recent quote while closed: plausibly the last session. Older quotes
    // fall through to stale above (10-minute bound), never "last session".
    return { kind: "delayed", detail: `Last session · observed ${ago}` };
  }
  if (ageS > 90) return { kind: "delayed", detail: `Delayed ${Math.round(ageS / 60)}m` };
  return { kind: "live", detail: "Current" };
}

/**
 * Score presentation: a zero with no scoring evidence is "Insufficient
 * history", never "Normal". Missing evidence must not read as calm markets.
 */
export function scoreLabel(score: number, missing: string[]): string {
  if (score === 0 && (missing.includes("baseline") || missing.includes("volatility"))) {
    return "Insufficient history";
  }
  return String(score);
}

export function describeEvidence(q: {dayChangePct: number | null; missing: string[]; volRatio: number | null; source: string}): string {
  if (q.dayChangePct == null || q.missing.includes("baseline") || q.missing.includes("volatility")) return "Not enough distinct observations to assess recent price behavior.";
  const move = q.dayChangePct === 0 ? "Unchanged since the previous observation" : `${q.dayChangePct > 0 ? "Up" : "Down"} ${Math.abs(q.dayChangePct).toFixed(2)}% since the previous observation`;
  return move + (q.source === "finnhub" ? ". Volume is not supplied by this feed." : q.volRatio == null ? ". Volume evidence is unavailable." : ` with ${q.volRatio.toFixed(1)}× recent-sample average volume.`);
}
