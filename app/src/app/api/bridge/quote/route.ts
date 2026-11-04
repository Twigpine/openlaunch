import { clientIp } from "@/lib/http";
import { rateLimited } from "@/lib/launchpad/editServer";
import { BRIDGE_PRIVATE_HEADERS, bridgeErrorResponse, getBridgeQuote, readBridgeJson } from "@/lib/bridge/relay";
import { BridgeApiError, parseBridgeRequest } from "@/lib/bridge/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const ip = clientIp(req);
  if (rateLimited(`bridge:quote:ip:${ip}`, 20)) return bridgeErrorResponse(new BridgeApiError("Too many quotes. Please wait a moment.", 429));
  try {
    if (req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new BridgeApiError("Send a JSON request.", 415);
    const length = req.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 2048)) throw new BridgeApiError("The request is too large.", 413);
    const input = parseBridgeRequest(await readBridgeJson(req.body, 2048));
    return Response.json(await getBridgeQuote(input), { headers: BRIDGE_PRIVATE_HEADERS });
  } catch (error) { return bridgeErrorResponse(error); }
}
