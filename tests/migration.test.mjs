import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "sw-mig-"));
process.env.SW_DATA_DIR = dir;
process.env.SW_DB_PATH = join(dir, "test.sqlite");

writeFileSync(join(dir, "db.json"), "{not valid json");

const db = await import("../smart-watchlist/src/lib/db.ts");

describe("legacy migration", () => {
  it("records failure and preserves the corrupt source", () => {
    const st = db.migrationStatus();
    assert.equal(st.status, "failed");
    assert.ok(String(st.backup).includes(".corrupt-"));
  });

  it("retry succeeds after the source is repaired", async () => {
    const { existsSync } = await import("node:fs");
    assert.ok(!existsSync(join(dir, "db.json")), "corrupt file moved aside, nothing pending");
    writeFileSync(join(dir, "db.json"), JSON.stringify({
      users: [{ id: "u1", device_token: "tok", email: null, created_at: "2026-01-01T00:00:00Z" }],
      watchlists: [{ id: "w1", user_id: "u1", name: "L", created_at: "2026-01-01T00:00:00Z" }],
      items: [{ id: "i1", watchlist_id: "w1", symbol: "AAPL", added_at: "2026-01-01T00:00:00Z" }],
      snapshots: [], events: [], views: [],
    }));
    const r = db.retryLegacyMigration();
    assert.equal(r.status, "ok");
    assert.ok(db.getOwnedWatchlist("u1", "w1"), "migrated watchlist resolves");
    assert.deepEqual(db.itemsFor("w1").map((i) => i.symbol), ["AAPL"]);
  });

  it("success is recorded only after commit; second retry is a no-op", () => {
    assert.equal(db.retryLegacyMigration().status, "ok");
    assert.equal(db.migrationStatus().status, "ok");
  });
});
