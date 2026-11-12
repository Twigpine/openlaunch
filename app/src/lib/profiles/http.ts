/**
 * Client IP for rate-limit keys. Fly's proxy sets fly-client-ip; the first x-forwarded-for entry is whatever the
 * client sent, so the fallback is the last one (the hop the proxy appended).
 * Deployment must strip/overwrite fly-client-ip or append the actual client to XFF;
 * directly exposed servers cannot authenticate arbitrary forwarding headers.
 */
export function clientIp(req: Request): string {
  return req.headers.get("fly-client-ip")?.trim() || (req.headers.get("x-forwarded-for") ?? "").split(",").at(-1)?.trim() || "0.0.0.0";
}

export type BodyRead = { ok: true; bytes: Uint8Array } | { ok: false; reason: "too_large" | "invalid" };

/** Count the actual request bytes before buffering or parsing; Content-Length is only an early rejection hint. */
export async function readBody(req: Request, maxBytes: number): Promise<BodyRead> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return { ok: false, reason: "invalid" };
  const declared = req.headers.get("content-length")?.trim();
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    void req.body?.cancel().catch(() => {});
    return { ok: false, reason: "too_large" };
  }
  if (!req.body) return { ok: true, bytes: new Uint8Array(0) };
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = req.body.getReader(); } catch { return { ok: false, reason: "invalid" }; }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) return { ok: false, reason: "invalid" };
      if (value.byteLength > maxBytes - size) return { ok: false, reason: "too_large" };
      size += value.byteLength;
      chunks.push(value);
    }
    complete = true;
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    return { ok: true, bytes };
  } catch {
    return { ok: false, reason: "invalid" };
  } finally {
    // Cancellation closes the stream immediately; an underlying cancel callback must not delay the rejection.
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** A bounded JSON object body, or null. Arrays, primitives, malformed JSON and oversized streams are rejected. */
export async function readJson(req: Request, maxBytes = 8_192): Promise<Record<string, unknown> | null> {
  const body = await readBody(req, maxBytes);
  if (!body.ok) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(body.bytes)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
