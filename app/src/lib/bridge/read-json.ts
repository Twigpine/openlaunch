import "server-only";
import { BridgeApiError } from "./validation";

/** Count streamed bytes, not Content-Length alone; cap reads even for chunked bodies. */
export async function readBridgeJson(body: ReadableStream<Uint8Array> | null, maxBytes: number, timeoutMs = 8_000): Promise<unknown> {
  if (!body) throw new BridgeApiError("Invalid JSON body.", 400);
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BridgeApiError("The bridge request timed out. Please try again.", 504)), timeoutMs); });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new BridgeApiError("The request is too large.", 413);
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof BridgeApiError) throw error;
    throw new BridgeApiError("Invalid JSON body.", 400);
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
