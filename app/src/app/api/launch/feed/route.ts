import { NextResponse } from "next/server";
import { getLaunchFeed } from "@/lib/launchpad/queries";
import { ethUsd } from "@/lib/launchpad/ethPrice";
import { memo } from "@/lib/launchpad/memo";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const usd = await ethUsd();
    return NextResponse.json({ items: await memo("feed", 2_000, () => getLaunchFeed(24, usd)) }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("[launch] feed failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "could not load feed" }, { status: 502 });
  }
}
