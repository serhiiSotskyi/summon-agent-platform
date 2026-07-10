import { NextResponse } from "next/server";
import { buildMcpProtectedResourceMetadata } from "@/lib/mcp/oauth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return NextResponse.json(buildMcpProtectedResourceMetadata(request), {
    headers: { "Cache-Control": "no-store" },
  });
}
