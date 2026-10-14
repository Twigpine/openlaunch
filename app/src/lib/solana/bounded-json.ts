/** Bound streamed input as well as Content-Length; never trust an upstream length header. */
export async function boundedText(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
): Promise<string> {
  if (!body) throw new Error("Missing response body");
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error("Response exceeds size limit");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts).toString("utf8");
}

export async function boundedJson(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
): Promise<unknown> {
  return JSON.parse(await boundedText(body, maximum));
}
