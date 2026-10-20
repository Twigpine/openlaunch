/**
 * Request helpers shared by API routes. No `server-only` import: the pure parts are unit-tested with node --test.
 */

/**
 * Client IP for rate-limit keys. Fly's proxy sets fly-client-ip. The first x-forwarded-for entry is whatever the
 * client sent, so the fallback is the last one (the hop the nearest proxy appended): a spoofed left-hand entry never
 * buys a fresh bucket. The cap keeps an absurd header from becoming an absurd map key.
 */
export function clientIp(req: Request): string {
  const fly = req.headers.get("fly-client-ip")?.trim();
  if (fly) return fly.slice(0, 128);
  const last = (req.headers.get("x-forwarded-for") ?? "").split(",").at(-1)?.trim();
  return (last || "0.0.0.0").slice(0, 128);
}

type BytesResult = { ok: true; bytes: Uint8Array } | { ok: false; tooLarge: boolean };

/**
 * Read a request body in bytes, refusing anything over `maxBytes`. The size cap holds before anything is buffered: a
 * declared length over the cap is refused outright, and the stream is read in bytes and cancelled the moment it passes
 * the cap (route handlers have no body limit of their own, and these routes are unauthenticated).
 */
async function readBytes(req: Request, maxBytes: number): Promise<BytesResult> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, tooLarge: true };
  if (!req.body) return { ok: false, tooLarge: false };
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
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    return { ok: true, bytes };
  } catch {
    return { ok: false, tooLarge: false };
  }
}

/** A JSON value (object, array or primitive), or undefined when the body is over the cap or not JSON. */
export async function readJsonValue(req: Request, maxBytes = 8_192): Promise<unknown | undefined> {
  const r = await readBytes(req, maxBytes);
  if (!r.ok) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(r.bytes)) as unknown;
  } catch {
    return undefined;
  }
}

/** A small JSON object body, or null. Arrays are not objects: callers that accept a batch use readJsonValue. */
export async function readJson(req: Request, maxBytes = 8_192): Promise<Record<string, unknown> | null> {
  const v = await readJsonValue(req, maxBytes);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** A text body (for JSON-RPC batches, which may be an array), or null when it is over the cap or the stream fails. */
export async function readText(req: Request, maxBytes = 8_192): Promise<string | null> {
  const r = await readBytes(req, maxBytes);
  return r.ok ? new TextDecoder().decode(r.bytes) : null;
}

/** A multipart form body, capped in bytes before parsing. */
export async function readFormData(req: Request, maxBytes: number): Promise<{ ok: true; form: FormData } | { ok: false; tooLarge: boolean }> {
  const r = await readBytes(req, maxBytes);
  if (!r.ok) return { ok: false, tooLarge: r.tooLarge };
  const type = req.headers.get("content-type");
  if (!type) return { ok: false, tooLarge: false };
  try {
    const body = new Uint8Array(r.bytes); // Uint8Array<ArrayBuffer>, which BodyInit accepts
    const form = await new Response(body, { headers: { "content-type": type } }).formData();
    return { ok: true, form };
  } catch {
    return { ok: false, tooLarge: false };
  }
}

/**
 * Read an upstream response body with a byte cap. Used by the JSON-RPC proxy: a huge eth_getLogs answer must become a
 * 502, not an unbounded allocation. `tooLarge` distinguishes the cap from a timeout or a connection reset, which the
 * route answers with its generic unavailable message.
 */
export type LimitedText = { ok: true; text: string } | { ok: false; tooLarge: boolean };

export async function readTextLimited(res: Response, maxBytes: number): Promise<LimitedText> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, tooLarge: true };
  }
  if (!res.body) return { ok: true, text: "" };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    return { ok: true, text: new TextDecoder().decode(bytes) };
  } catch {
    return { ok: false, tooLarge: false };
  }
}
