import { NextResponse } from "next/server";
import { searchSymbols } from "@/lib/companies";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return NextResponse.json({ results: searchSymbols(q) });
}
