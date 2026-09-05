export const SCORE_VERSION = 2;
export const THRESHOLD = 55;

/** Minimum evidence before a component may contribute. Missing inputs score
 *  zero WITHOUT reweighting the rest, so sparse data never looks stronger. */
export const MIN_RETURNS = 5;
export const MIN_VOL_SAMPLES = 3;
export const MIN_RANGE_SAMPLES = 5;
export const MIN_REVERSAL_CLOSES = 7;

export interface ScoreEvidence {
  price: number;
  /** Return baseline: previous accepted observation. Null when unknown. */
  prevPrice: number | null;
  volume: number;
  /** Actual comparable return history (Welford). */
  nRet: number;
  stdRet: number | null;
  nVol: number;
  avgVol: number | null;
  rangeHi: number | null;
  rangeLo: number | null;
  rangeN: number;
  /** Oldest-first accepted closes for trend windows. */
  closes: number[];
}

export interface ScoreComponents { surprise: number; volume: number; range: number; reversal: number }

export interface ScoredResult {
  total: number;
  components: ScoreComponents;
  reasons: string[];
  /** Unmet evidence requirements, e.g. "volatility". Visible, never hidden. */
  missing: string[];
  version: number;
  inputs: { z: number | null; volRatio: number | null };
}

export function scoreQuote(ev: ScoreEvidence): ScoredResult {
  const missing: string[] = [];
  const components: ScoreComponents = { surprise: 0, volume: 0, range: 0, reversal: 0 };
  const reasons: string[] = [];
  let z: number | null = null;
  let volRatio: number | null = null;

  if (!(ev.price > 0) || ev.prevPrice == null || !(ev.prevPrice > 0)) {
    return { total: 0, components, reasons, missing: ["baseline"], version: SCORE_VERSION, inputs: { z, volRatio } };
  }
  const ret = (ev.price - ev.prevPrice) / ev.prevPrice;

  if (ev.nRet >= MIN_RETURNS && ev.stdRet != null && ev.stdRet > 0) {
    z = Math.min(Math.abs(ret) / ev.stdRet, 6);
    components.surprise = Math.min(z / 3, 1) * 40;
    if (z >= 2) reasons.push("sized_move");
  } else {
    missing.push("volatility");
  }

  if (ev.nVol >= MIN_VOL_SAMPLES && ev.avgVol != null && ev.avgVol > 0) {
    volRatio = ev.volume / ev.avgVol;
    components.volume = Math.min(Math.max(volRatio - 1, 0) / 2, 1) * 25;
    if (volRatio >= 1.8) reasons.push("volume_surge");
  } else {
    missing.push("volume_baseline");
  }

  if (ev.rangeN >= MIN_RANGE_SAMPLES && ev.rangeHi != null && ev.rangeLo != null) {
    if (ev.price >= ev.rangeHi && ev.rangeHi > 0) { components.range = 20; reasons.push("range_high"); }
    else if (ev.price <= ev.rangeLo && ev.rangeLo > 0) { components.range = 20; reasons.push("range_low"); }
  } else {
    missing.push("observed_range");
  }

  if (ev.closes.length >= MIN_REVERSAL_CLOSES) {
    const c = ev.closes;
    const short = avg(c.slice(-3));
    const med = avg(c.slice(-6));
    const prevShort = avg(c.slice(-4, -1));
    const prevMed = avg(c.slice(-7, -1));
    if ((prevShort >= prevMed) !== (short >= med)) { components.reversal = 15; reasons.push("trend_reversal"); }
  } else {
    missing.push("trend_window");
  }

  const total = Math.round(Math.min(
    components.surprise + components.volume + components.range + components.reversal, 100));
  return { total, components, reasons, missing, version: SCORE_VERSION, inputs: { z, volRatio } };
}

function avg(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length; }

/** Stable fingerprint for dedupe: same condition = same fingerprint. */
export function eventFingerprint(symbol: string, reasons: string[], ret: number): string {
  const dir = ret > 0 ? "up" : ret < 0 ? "down" : "flat";
  return `${symbol}|${[...reasons].sort().join(",")}|${dir}`;
}

export function buildSummary(ret: number, volRatio: number | null, reasons: string[]): string {
  const dir = ret >= 0 ? "Up" : "Down";
  const parts = [`${dir} ${Math.abs(ret * 100).toFixed(1)}%`];
  if (reasons.includes("volume_surge") && volRatio != null) parts.push(`on ${volRatio.toFixed(1)}× recent-sample average volume`);
  if (reasons.includes("range_high")) parts.push("new observed high");
  if (reasons.includes("range_low")) parts.push("new observed low");
  if (reasons.includes("trend_reversal")) parts.push("reversing recent trend");
  return parts.join(" — ");
}
