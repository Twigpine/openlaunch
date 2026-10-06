/**
 * Response security headers. Pure module (node --test loads it directly; no "@/" imports).
 *
 * The CSP is nonce-based: proxy.ts mints a nonce per request and forwards it as the
 * `x-nonce` request header plus the policy itself, which Next.js reads to stamp its own
 * inline scripts; layout.tsx hands the nonce to next-themes for its theme script.
 * Everything else is same-origin. Third-party origins are listed here, once, with a reason.
 */

/**
 * Coinbase Wallet SDK (wagmi's coinbaseWallet connector). Smart Wallet signs in a popup
 * (window.open → keys.coinbase.com, postMessage), so no frame-src is needed. The mobile
 * app pairs over the WalletLink relay, and some reads go through the wallet's RPC.
 */
export const WALLET_CONNECT_SRC = [
  "https://keys.coinbase.com",
  "https://rpc.wallet.coinbase.com",
  "https://www.walletlink.org",
  "wss://www.walletlink.org",
] as const;

const NONCE_RE = /^[A-Za-z0-9+/]{16,}={0,2}$/;

/** Base64 of at least 16 random bytes. Runs in Node and the browser runtime alike. */
export function cspNonce(bytes: Uint8Array): string {
  if (bytes.length < 16) throw new Error("csp nonce needs at least 16 random bytes");
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export type CspOptions = {
  /** Development: Next's dev tooling evals source maps and talks to HMR over ws. */
  dev?: boolean;
  /** Extra origins the browser may call (dev RPC overrides, a non-default site URL). */
  connectSrc?: readonly string[];
};

/** True for a bare origin such as https://host or wss://host:1234 (no path, query, or credentials). */
export function isOrigin(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return ["https:", "http:", "wss:", "ws:"].includes(u.protocol) && u.origin === value;
}

/**
 * The Content-Security-Policy for one request. Scripts in the HTML run only with this nonce;
 * 'strict-dynamic' extends that trust to scripts they load at runtime (Next.js chunks) but not to
 * injected markup. Everything else is same-origin apart from the listed wallet and image sources.
 */
export function buildCsp(nonce: string, { dev = false, connectSrc = [] }: CspOptions = {}): string {
  if (!NONCE_RE.test(nonce)) throw new Error("csp nonce must be base64");
  const connect = new Set<string>(["'self'", ...WALLET_CONNECT_SRC, ...connectSrc.filter(isOrigin)]);
  if (dev) for (const s of ["ws:", "http://localhost:*", "http://127.0.0.1:*"]) connect.add(s);
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    // App Router navigation retains the original document's CSP. The exact
    // chart origin must be allowed on every entry page, not only /t routes.
    "frame-src https://www.geckoterminal.com",
    "form-action 'self'",
    // Nonce for scripts in the HTML; 'strict-dynamic' trusts what those scripts load (Next's chunks).
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // Server-rendered inline `style` attributes and next/font. CSSOM writes are not gated by CSP.
    "style-src 'self' 'unsafe-inline'",
    // Token logos are user-supplied https URLs (validated server-side); stock marks are data: SVGs.
    "img-src 'self' https: data:",
    "font-src 'self'",
    `connect-src ${[...connect].join(" ")}`,
  ];
  if (!dev) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

/** Origins the browser must reach besides the page itself: the configured site URL and dev RPC overrides. */
export function extraConnectOrigins(env: Record<string, string | undefined>): string[] {
  const out = new Set<string>();
  for (const key of ["NEXT_PUBLIC_SITE_URL", "NEXT_PUBLIC_RPC_URL_BASE", "NEXT_PUBLIC_RPC_URL_ROBINHOOD", "NEXT_PUBLIC_RPC_URL_ARC"]) {
    const value = env[key]?.trim();
    if (!value) continue;
    try {
      const origin = new URL(value).origin;
      if (isOrigin(origin)) out.add(origin);
    } catch {
      /* not a URL; nothing to allow */
    }
  }
  return [...out];
}

/** Static headers for every response (next.config.ts). The CSP is per request and lives in proxy.ts. */
export const SECURITY_HEADERS: readonly { key: string; value: string }[] = [
  { key: "x-content-type-options", value: "nosniff" },
  // Belt and braces with frame-ancestors for browsers that predate CSP2.
  { key: "x-frame-options", value: "DENY" },
  { key: "referrer-policy", value: "strict-origin-when-cross-origin" },
  { key: "permissions-policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  // Fly already forces https; this stops the first plain-http hop on return visits.
  { key: "strict-transport-security", value: "max-age=63072000; includeSubDomains" },
];
