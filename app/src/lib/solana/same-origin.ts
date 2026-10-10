/**
 * Same-origin check for browser calls to the Solana routes. The request URL cannot be compared: under the standalone
 * server it is the bind address (http://0.0.0.0:3000), not the public host. Compare the Origin's host with the host the
 * browser addressed (the edge's X-Forwarded-Host, else Host), as Next does for Server Actions. A page on another site
 * cannot set either header without a CORS preflight, which these routes never grant. A request with no Origin is not
 * a cross-site browser request (browsers always send Origin on POST) and is left to the rate limits.
 */
export function sameOriginRequest(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return req.headers.get("sec-fetch-site") !== "cross-site";
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const addressed = (
    req.headers.get("x-forwarded-host")?.split(",")[0] ??
    req.headers.get("host") ??
    ""
  )
    .trim()
    .toLowerCase();
  return addressed !== "" && host === addressed;
}
