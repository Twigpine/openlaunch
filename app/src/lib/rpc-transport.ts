/** Pure (node --test loads it directly): build viem HTTP transport settings that never carry a keyed RPC URL. */

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * viem quotes the transport's URL in every request error ("URL: https://…/v2/<key>"), and a keyed provider carries its
 * API key in the path or the query. So the transport is given the origin alone (the host is not a secret, and still
 * says which node failed), and the request itself goes to the full URL through fetchFn: the key is in no error message,
 * so it cannot reach a log line, a stored error or an API response whichever caller forgets to redact.
 * An unset or unparsable URL is passed through unchanged (viem then uses the chain's public RPC, or fails as before).
 */
export function keylessHttp(url: string | undefined, fetchImpl: FetchFn = (input, init) => fetch(input, init)): { url: string | undefined; fetchFn?: FetchFn } {
  if (!url) return { url };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { url };
  if (parsed.pathname === "/" && !parsed.search) return { url }; // nothing to hide (viem itself moves user:pass@ into a header)
  // Basic-auth credentials stay on the label: viem turns them into the Authorization header and drops them from the
  // URL it quotes, and fetch refuses a URL that still carries them, so the request URL goes without
  const label = new URL(parsed.origin);
  label.username = parsed.username;
  label.password = parsed.password;
  const target = new URL(url);
  target.username = "";
  target.password = "";
  const to = target.toString();
  // viem merges the requests of one tick by transport URL (its batch scheduler is keyed by it), so two upstreams must
  // never share a label: a second chain on the same host would ride the first chain's request. The first upstream on
  // a host keeps the bare origin; each further one gets a numbered path, which says nothing about the real one.
  const host = parsed.username ? label.toString() : parsed.origin;
  const known = upstreams.get(host) ?? [];
  if (!known.includes(to)) upstreams.set(host, [...known, to]);
  const n = (upstreams.get(host) ?? []).indexOf(to);
  return { url: n === 0 ? host : `${host.replace(/\/$/, "")}/upstream-${n + 1}`, fetchFn: (_input, init) => fetchImpl(to, init) };
}

/** The real upstream URLs seen per label host, in first-seen order (per process; a handful of entries). */
const upstreams = new Map<string, string[]>();
