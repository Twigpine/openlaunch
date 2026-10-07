/**
 * Client IP for rate-limit keys. Fly's proxy sets fly-client-ip; the first x-forwarded-for entry is whatever the
 * client sent, so the fallback is the last one (the hop the proxy appended): a spoofed header never buys a fresh bucket.
 */
export function clientIp(req: Request): string {
  return req.headers.get("fly-client-ip")?.trim() || (req.headers.get("x-forwarded-for") ?? "").split(",").at(-1)?.trim() || "0.0.0.0";
}

export async function readJson(req: Request, maxBytes = 8_192): Promise<Record<string, unknown> | null> {
  try {
    const text = await req.text();
    if (text.length > maxBytes) return null;
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
