/** Pure (node --test loads it directly): strip URLs from an error message before it is persisted or returned. */

/**
 * viem's HTTP errors quote the upstream URL ("URL: https://…/v2/<key>"), and a keyed RPC provider carries its API key in
 * the path. Every URL is replaced, since the key can also appear in "Request body" or a wrapped cause. A bracketed IPv6
 * host swallows its closing bracket and the path after it, so that tail cannot ride along behind "<url>".
 */
export function redactUrls(message: string): string {
  return message.replace(/\b(?:https?|wss?):\/\/(?:\[[^\]\s]+\][^\s"'`<>)]*|[^\s"'`<>)\]]+)/gi, "<url>");
}

/**
 * An error as an API response or a stored, publicly shown reason may carry it: its first line alone (viem puts the
 * request URL, the request body and the node's own answer on the lines after it), with any URL removed, and bounded.
 */
export function publicError(err: unknown, fallback = "failed"): string {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return redactUrls(message.split("\n")[0]).trim().slice(0, 200) || fallback;
}
