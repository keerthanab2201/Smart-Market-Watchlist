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
