import { rateLimited } from "@/lib/launchpad/editServer";
import { BRIDGE_PRIVATE_HEADERS, bridgeErrorResponse, getBridgeStatus } from "@/lib/bridge/relay";
import { BridgeApiError } from "@/lib/bridge/validation";
import { getCctpStatus, parseCctpStatusRequest } from "@/lib/bridge/cctp-server";
import { clientIp } from "@/lib/profiles/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  if (rateLimited(`bridge:status:ip:${clientIp(req)}`, 100)) return bridgeErrorResponse(new BridgeApiError("Too many status requests. Please wait a moment.", 429));
  try {
    const params = new URL(req.url).searchParams;
    // A Circle burn is found by its source transaction and checked against the wallet, amount and route it was for.
    if (params.has("provider")) return Response.json(await getCctpStatus(parseCctpStatusRequest(params)), { headers: BRIDGE_PRIVATE_HEADERS });
    if (params.size !== 1 || !params.has("requestId")) throw new BridgeApiError("Invalid bridge request ID.", 400);
    return Response.json(await getBridgeStatus(params.get("requestId")!), { headers: BRIDGE_PRIVATE_HEADERS });
  } catch (error) { return bridgeErrorResponse(error); }
}
