/**
 * Client IP for rate-limit keys. Fly's proxy sets fly-client-ip; the first x-forwarded-for entry is whatever the
 * client sent, so the fallback is the last one (the hop the proxy appended): a spoofed header never buys a fresh bucket.
 */
export function clientIp(req: Request): string {
  return req.headers.get("fly-client-ip")?.trim() || (req.headers.get("x-forwarded-for") ?? "").split(",").at(-1)?.trim() || "0.0.0.0";
}

/**
 * A small JSON object body, or null. The size cap holds before anything is buffered: a declared length over the cap
 * is refused outright, and the stream is read in bytes and cancelled the moment it passes the cap (route handlers have
 * no body limit of their own, and these routes are unauthenticated).
 */
export async function readJson(req: Request, maxBytes = 8_192): Promise<Record<string, unknown> | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    const v = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
