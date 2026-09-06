import { NextResponse } from "next/server";
import { authorizeIngest } from "@/lib/db";
import { collapseDuplicateObservations, dedupeStatus } from "@/lib/db";

/**
 * Explicit legacy-duplicate cleanup (see collapseDuplicateObservations).
 * Same authorization as ingestion; reports counts and the backup key.
 */
export async function POST(req: Request) {
  const secret = process.env.INGEST_SECRET;
  if (secret && !authorizeIngest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!secret && process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const result = collapseDuplicateObservations();
  return NextResponse.json({ ok: true, ...result });
}

export async function GET() {
  return NextResponse.json({ ok: true, dedupe: dedupeStatus() });
}
