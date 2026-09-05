import { describe, it } from "node:test";
import assert from "node:assert/strict";

const fmt = await import("../smart-watchlist/src/lib/format.ts");

describe("display helpers", () => {
  it("directionOf follows the displayed comparison", () => {
    assert.equal(fmt.directionOf(1.2), "up");
    assert.equal(fmt.directionOf(-0.5), "down");
    assert.equal(fmt.directionOf(0), "flat");
    assert.equal(fmt.directionOf(null), "flat");
  });

  it("timeAgo uses the injected clock", () => {
    const now = new Date("2026-09-01T12:00:00Z").getTime();
    assert.equal(fmt.timeAgo(new Date(now - 30_000).toISOString(), now), "30s ago");
    assert.equal(fmt.timeAgo(new Date(now - 5 * 60_000).toISOString(), now), "5m ago");
    assert.equal(fmt.timeAgo(new Date(now - 2 * 3600_000).toISOString(), now), "2h ago");
  });

  it("fmtMoney uses currency per symbol", () => {
    assert.ok(fmt.fmtMoney("AAPL", 232.5).includes("$"));
    const inr = fmt.fmtMoney("RELIANCE", 2985);
    assert.ok(inr.includes("₹") || inr.includes("INR"));
  });

  it("fmtSessionChange is null without session data", () => {
    assert.equal(fmt.fmtSessionChange(null, 100), null);
    assert.ok((fmt.fmtSessionChange(100, 108) ?? "").includes("8.00%"));
  });
});
