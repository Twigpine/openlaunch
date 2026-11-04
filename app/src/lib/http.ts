/**
 * Request helpers shared by API routes. No `server-only` import: the pure parts are unit-tested with node --test.
 */

/** How many proxies of our own a request passes before it reaches the app (TRUSTED_PROXY_HOPS). */
function trustedProxyHops(): number {
  const n = Math.trunc(Number(process.env.TRUSTED_PROXY_HOPS ?? ""));
  // blank, zero, negative or junk means the single proxy every deployment has
  return n > 1 ? n : 1;
}

/**
 * Client IP for rate-limit keys. Fly Proxy sets fly-client-ip to the peer it accepted the connection from — the client
 * while Fly's proxy is the outermost one, and the proxy service in front of it once TRUSTED_PROXY_HOPS counts a hop
 * above Fly — and it appends one x-forwarded-for entry of its own: the address assigned to the app, always rightmost and
 * never the client (fly.io/docs/networking/request-headers). So the chain is counted in from the right past that entry,
 * and the address a client wrote at the front is never reached.
 *
 * With no Fly header the request came through a plain reverse proxy that appends the peer it saw, so the last entry is
 * the client. A count deeper than the header falls back to fly-client-ip, or to 0.0.0.0 (one shared bucket), never to a
 * client-written entry. Counting hops above Fly still assumes the proxy in front is the only way in: a client that
 * reaches the app around it seeds the chain itself, which is a firewall's job, not this header's (the reverse parse
 * MDN prescribes). The cap keeps an absurd header from becoming an absurd map key.
 */
export function clientIp(req: Request): string {
  const fly = req.headers.get("fly-client-ip")?.trim();
  const hops = trustedProxyHops();
  if (fly && hops === 1) return fly.slice(0, 128);
  const entries = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim());
  const picked = entries.length >= hops ? entries[entries.length - hops] : "";
  return (picked || fly || "0.0.0.0").slice(0, 128);
}

type BytesResult = { ok: true; bytes: Uint8Array } | { ok: false; tooLarge: boolean };

/**
 * Read a stream in bytes, refusing anything over `maxBytes`. The size cap holds before anything is buffered: the
 * stream is read chunk by chunk and cancelled the moment it passes the cap (route handlers have no body limit of
 * their own, and these routes are unauthenticated). `tooLarge` separates the cap from a read failure, so each caller
 * answers with its own message. Shared by request bodies and upstream responses so one fix covers both.
 */
async function readStreamLimited(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<BytesResult> {
  const reader = body.getReader();
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

/** A request body in bytes. A declared length over the cap is refused before the stream is touched. */
async function readBytes(req: Request, maxBytes: number): Promise<BytesResult> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, tooLarge: true };
  if (!req.body) return { ok: false, tooLarge: false };
  return readStreamLimited(req.body, maxBytes);
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
  const r = await readStreamLimited(res.body, maxBytes);
  return r.ok ? { ok: true, text: new TextDecoder().decode(r.bytes) } : r;
}
