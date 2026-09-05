import { NextResponse } from "next/server";
import { retryLegacyMigration, migrationStatus } from "@/lib/db";
import { authorizeIngest } from "@/lib/shared";

/** Retry a failed legacy JSON import. Gated like ingestion when a secret is set. */
export async function POST(req: Request) {
  const secret = process.env.INGEST_SECRET;
  if (secret && !authorizeIngest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, migration: retryLegacyMigration() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "retry failed" }, { status: 409 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, migration: migrationStatus() });
}
