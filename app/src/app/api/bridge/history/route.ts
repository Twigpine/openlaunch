import { rateLimited } from "@/lib/launchpad/editServer";
import { BRIDGE_PRIVATE_HEADERS, bridgeErrorResponse, getBridgeHistory } from "@/lib/bridge/relay";
import { BridgeApiError } from "@/lib/bridge/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** One wallet's bridge transfers from Relay, or `{ relay: "off" }` while no Relay API key is configured. */
export async function GET(req: Request) {
  const ip = (req.headers.get("fly-client-ip") || req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "0.0.0.0";
  if (rateLimited(`bridge:history:ip:${ip}`, 30)) return bridgeErrorResponse(new BridgeApiError("Too many history requests. Please wait a moment.", 429));
  try {
    const params = new URL(req.url).searchParams;
    if (params.size !== 1 || !params.has("address")) throw new BridgeApiError("Invalid wallet address.", 400);
    return Response.json(await getBridgeHistory(params.get("address")!), { headers: BRIDGE_PRIVATE_HEADERS });
  } catch (error) { return bridgeErrorResponse(error); }
}
