/**
 * Client IP for rate-limit keys. Fly's proxy sets fly-client-ip; the first x-forwarded-for entry is whatever the
 * client sent, so the fallback is the last one (the hop the proxy appended).
 * Ingress must overwrite fly-client-ip with the actual client IP, or strip it and append the actual client to XFF;
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
  let bytes = new Uint8Array(0);
  let size = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) return { ok: false, reason: "invalid" };
      if (value.byteLength === 0) continue;
      if (value.byteLength > maxBytes - size) return { ok: false, reason: "too_large" };
      // Copy each view now: retaining it could pin an arbitrarily large backing buffer,
      // and an entry per tiny chunk would add memory beyond the byte budget.
      if (size + value.byteLength > bytes.byteLength) {
        const capacity = Math.min(maxBytes, Math.max(size + value.byteLength, 8_192, bytes.byteLength * 2));
        const grown = new Uint8Array(capacity);
        grown.set(bytes);
        bytes = grown;
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
    complete = true;
    return { ok: true, bytes: bytes.subarray(0, size) };
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
