import { NextResponse } from "next/server";
import { listApplications } from "@/lib/launchpad/pairApplyServer";

export const dynamic = "force-dynamic";

/** GET: the application queue (in progress first, then the latest decided). Public: every application page is. */
export async function GET() {
  return NextResponse.json({ applications: await listApplications() }, { headers: { "cache-control": "no-store" } });
}
