/**
 * Origin policy for the MCP endpoint (MCP's DNS-rebinding guidance).
 *
 * A browser sends `Origin` on a cross-origin POST. Without a check, any page
 * could make a visitor's browser call a local MCP server; the MCP specification
 * tells servers to validate the header. Non-browser clients (the usual MCP
 * transport) send no Origin and are allowed through; the endpoint is public and
 * read-only either way.
 *
 * The site's own origin and its `www.` twin are allowed, and in development so
 * are localhost and 127.0.0.1 on any port (Next picks another port when 3000 is
 * busy). Everything else is refused.
 */

function parseOrigin(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // An origin is scheme://host[:port] exactly: no path, query, fragment or credentials.
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  return url;
}

function sameHost(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host;
}

export function originAllowed(origin: string | null, siteUrl: string, options: { dev?: boolean } = {}): boolean {
  if (origin === null) return true; // a non-browser MCP client
  const parsed = parseOrigin(origin.trim());
  if (!parsed) return false;
  if (options.dev && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]")) return true;
  const site = parseOrigin(siteUrl.trim());
  if (!site) return false;
  if (sameHost(parsed, site)) return true;
  // The legacy host redirects pages but /api stays reachable on it; accept both
  // the bare site and its www twin so a browser client on either is not blocked.
  if (site.hostname.startsWith("www.")) {
    const bare = new URL(site.href);
    bare.hostname = site.hostname.slice(4);
    if (sameHost(parsed, bare)) return true;
  } else {
    const www = new URL(site.href);
    www.hostname = `www.${site.hostname}`;
    if (sameHost(parsed, www)) return true;
  }
  return false;
}
