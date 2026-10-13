/** `bytes` secure random bytes as lowercase hex (Web Crypto: the same in the browser and on the server). */
export function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** A random single-use nonce for a signed write: 32 lowercase hex characters (the shape the servers accept). */
export function nonce(): string {
  return randomHex(16);
}
