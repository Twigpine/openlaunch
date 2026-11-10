import { NextResponse, type NextRequest } from "next/server";
import { BRAND_DOMAIN, LEGACY_DOMAIN } from "@/lib/brand";
import { buildCsp, cspNonce, extraConnectOrigins } from "@/lib/security-headers";

const DEV = process.env.NODE_ENV === "development";
// Literal accesses so Next inlines the same build-time values the client bundle uses (see browserRpc).
const CONNECT_SRC = extraConnectOrigins({
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  NEXT_PUBLIC_RPC_URL_BASE: process.env.NEXT_PUBLIC_RPC_URL_BASE,
  NEXT_PUBLIC_RPC_URL_ROBINHOOD: process.env.NEXT_PUBLIC_RPC_URL_ROBINHOOD,
  NEXT_PUBLIC_RPC_URL_ARC: process.env.NEXT_PUBLIC_RPC_URL_ARC,
  NEXT_PUBLIC_RPC_URL_ELYSIUM: process.env.NEXT_PUBLIC_RPC_URL_ELYSIUM,
});

/**
 * basebid.lol → openlaunch.lol. Permanent redirect for pages; /api stays served
 * on both hosts because early launches carry basebid.lol metadata URIs on-chain.
 *
 * Every other response carries a nonce-based Content-Security-Policy. Next.js reads
 * the nonce from the CSP *request* header to stamp its inline scripts, layout.tsx
 * reads `x-nonce` for next-themes, and the response repeats the same policy.
 */
export function proxy(req: NextRequest) {
  const host = req.headers.get("host")?.toLowerCase() ?? "";
  if ((host === LEGACY_DOMAIN || host === `www.${LEGACY_DOMAIN}` || host === `www.${BRAND_DOMAIN}`) && !req.nextUrl.pathname.startsWith("/api/")) {
    const url = req.nextUrl.clone();
    url.host = BRAND_DOMAIN;
    url.port = "";
    url.protocol = "https:";
    return NextResponse.redirect(url, 308);
  }
  const nonce = cspNonce(crypto.getRandomValues(new Uint8Array(16)));
  const csp = buildCsp(nonce, { dev: DEV, connectSrc: CONNECT_SRC });
  const headers = new Headers(req.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("content-security-policy", csp);
  return res;
}

export const config = { matcher: ["/((?!_next/|favicon|icon|apple-icon|opengraph-image).*)"] };
