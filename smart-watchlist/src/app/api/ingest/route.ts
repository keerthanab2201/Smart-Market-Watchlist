import { NextResponse } from "next/server";
import { runIngestAsync, ingestHealth, authorizeIngest } from "@/lib/shared";
import { getProvider } from "@/lib/market";

// GET never mutates: scheduler status + last ingestion health only.
export async function GET() {
  const provider = getProvider();
  return NextResponse.json({
    ok: true,
    scheduler: "in-process single-flight, 60s interval, shared across users (see instrumentation.ts)",
    provider: provider.name,
    mode: provider.kind === "finnhub" ? "real provider (verify key/quota)" : "zero-key simulation",
    health: ingestHealth(),
  });
}

// POST performs one shared ingestion run. External callers must present the
// ingestion secret; without a configured or matching secret the request is
// rejected and the internal scheduler cadence is unaffected.
export async function POST(req: Request) {
  if (!authorizeIngest(req)) {
    return NextResponse.json(
      { error: "unauthorized: configure INGEST_SECRET and send it as x-ingest-secret" },
      { status: 401 }
    );
  }
  const r = await runIngestAsync();
  return NextResponse.json({ ok: true, ...r });
}
