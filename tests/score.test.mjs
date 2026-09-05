import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scoreQuote, buildSummary, eventFingerprint, SCORE_VERSION, THRESHOLD,
  MIN_RETURNS, MIN_VOL_SAMPLES, MIN_RANGE_SAMPLES, MIN_REVERSAL_CLOSES,
} from "../smart-watchlist/src/lib/score.ts";

const nvda = {
  price: 118, prevPrice: 128, volume: 820_000_000,
  nRet: 10, stdRet: 0.012, nVol: 10, avgVol: 200_000_000,
  rangeHi: 140, rangeLo: 119, rangeN: 10,
  closes: [124, 125, 126, 126.5, 127, 128, 118],
};

describe("scoreQuote", () => {
  it("exposes version 2 and threshold 55", () => {
    assert.equal(SCORE_VERSION, 2);
    assert.equal(THRESHOLD, 55);
  });

  it("deterministic demo bands: NVDA=100, TSLA=65", () => {
    const n = scoreQuote(nvda);
    assert.equal(n.total, 100);
    assert.deepEqual([...n.reasons].sort(), ["range_low", "sized_move", "trend_reversal", "volume_surge"]);
    assert.deepEqual(n.missing, []);
    const t = scoreQuote({
      price: 253, prevPrice: 242, volume: 285_000_000,
      nRet: 10, stdRet: 0.015, nVol: 10, avgVol: 95_000_000,
      rangeHi: 260, rangeLo: 180, rangeN: 10,
      closes: [240, 241, 242, 243, 244, 242, 253],
    });
    assert.equal(t.total, 65);
  });

  it("missing baseline yields zero with no fabricated return", () => {
    const r = scoreQuote({ ...nvda, prevPrice: null });
    assert.equal(r.total, 0);
    assert.ok(r.missing.includes("baseline"));
  });

  it("sparse inputs stay visible and are never rescaled", () => {
    const r = scoreQuote({ ...nvda, nRet: 2, stdRet: null, nVol: 0, avgVol: null, rangeHi: null, rangeLo: null, rangeN: 0, closes: [1, 2, 3] });
    assert.ok(r.missing.includes("volatility"));
    assert.ok(r.missing.includes("volume_baseline"));
    assert.ok(r.missing.includes("observed_range"));
    assert.ok(r.missing.includes("trend_window"));
    // Only reversal is missing-gated here; with 3 closes even that is missing.
    assert.equal(r.total, 0);
  });

  it("partial evidence scores only available components", () => {
    const r = scoreQuote({ ...nvda, nVol: 0, avgVol: null, rangeHi: null, rangeLo: null, rangeN: 0 });
    assert.equal(r.total, 40 + 15); // surprise + reversal only
    assert.ok(r.missing.includes("volume_baseline"));
    assert.ok(r.missing.includes("observed_range"));
  });

  it(`reversal needs ${MIN_REVERSAL_CLOSES} complete closes (no /6-on-5 bug)`, () => {
    const r = scoreQuote({ ...nvda, closes: [126, 127, 128, 129, 130, 118] });
    assert.equal(r.components.reversal, 0);
    assert.ok(r.missing.includes("trend_window"));
  });

  it("uses minimum-sample constants", () => {
    assert.equal(MIN_RETURNS, 5);
    assert.equal(MIN_VOL_SAMPLES, 3);
    assert.equal(MIN_RANGE_SAMPLES, 5);
    assert.equal(MIN_REVERSAL_CLOSES, 7);
  });

  it("summary avoids invented 52-week / largest-move claims", () => {
    const s = buildSummary(-0.078, 4.1, ["sized_move", "volume_surge", "range_low", "trend_reversal"]);
    assert.ok(!s.includes("52-week") && !s.includes("largest move"));
    assert.ok(s.includes("observed low"));
  });

  it("fingerprints separate direction and reason sets", () => {
    const a = eventFingerprint("NVDA", ["b", "a"], 0.05);
    const b = eventFingerprint("NVDA", ["a", "b"], -0.05);
    assert.notEqual(a, b);
    assert.equal(eventFingerprint("NVDA", ["b", "a"], 0.05), a);
  });
});
