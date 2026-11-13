import { createSiweMessage, parseSiweMessage } from "viem/siwe";
import { isAddress } from "viem";
import { CHAINS } from "@/lib/chainPublic";

/**
 * Admin sign-in: one Sign-In with Ethereum message (EIP-4361) from an admin wallet buys an 8-hour session. The standard
 * format matters: wallets that support it compare the message's domain with the site asking for the signature and
 * warn on a mismatch, so a look-alike site cannot quietly collect a sign-in for openlaunch. Shared by the sign-in card
 * (which builds the message) and the server (which accepts only the exact text this file would build).
 */
export const ADMIN_SIGN_IN_STATEMENT = "Sign in to the openlaunch admin. A signature, not a transaction: it costs nothing and moves nothing.";
/** Signed on Base, where the admin wallets live (a smart wallet's signature is checked there). */
export const ADMIN_SIGN_IN_CHAIN_ID = CHAINS.base.id;
/** A server-issued nonce, and the message carrying it, are good for 5 minutes. */
export const ADMIN_NONCE_TTL_MS = 5 * 60_000;
/** The message's own Expiration Time: issued at + 5 minutes. */
export const ADMIN_MESSAGE_TTL_MS = ADMIN_NONCE_TTL_MS;
/** How far a wallet's clock may run ahead of the server's. */
const CLOCK_SKEW_MS = 60_000;
/** A session lasts 8 hours from sign-in, never extended. */
export const ADMIN_SESSION_MS = 8 * 60 * 60_000;
/** Active sessions per wallet; signing in again past this ends the oldest. */
export const ADMIN_SESSIONS_MAX = 5;
const MAX_MESSAGE = 2_000;

export type AdminSignInFields = { origin: string; address: string; nonce: string; issuedAt: Date };

/** The exact sign-in text for an origin (https://openlaunch.lol), an address, a server nonce and a time. */
export function buildAdminSignInMessage(p: AdminSignInFields): string {
  const url = new URL(p.origin);
  return createSiweMessage({
    domain: url.host,
    address: p.address as `0x${string}`,
    statement: ADMIN_SIGN_IN_STATEMENT,
    uri: url.origin,
    version: "1",
    chainId: ADMIN_SIGN_IN_CHAIN_ID,
    nonce: p.nonce,
    issuedAt: p.issuedAt,
    expirationTime: new Date(p.issuedAt.getTime() + ADMIN_MESSAGE_TTL_MS),
  });
}

export type AdminSignInCheck = { ok: true; wallet: string; nonce: string } | { ok: false; error: string; status: number };

/**
 * Read a signed sign-in message without trusting any of it: it must be byte for byte the text buildAdminSignInMessage
 * makes for one of `origins` (so no extra fields, resources or odd formatting get through), for Base, freshly issued
 * and not expired. The signature, the nonce and the admin list are checked by the caller.
 */
export function checkAdminSignIn(message: unknown, opts: { origins: readonly string[]; now: number }): AdminSignInCheck {
  const bad = (error: string): AdminSignInCheck => ({ ok: false, error, status: 400 });
  if (typeof message !== "string" || message.length === 0 || message.length > MAX_MESSAGE) return bad("bad sign-in message");
  const m = parseSiweMessage(message);
  if (!m.address || !isAddress(m.address) || !m.nonce || !m.uri || !m.domain || !(m.issuedAt instanceof Date) || Number.isNaN(m.issuedAt.getTime())) return bad("bad sign-in message");
  const origin = opts.origins.find((o) => new URL(o).origin === m.uri && new URL(o).host === m.domain);
  if (!origin) return bad("this sign-in was made for another site");
  if (m.chainId !== ADMIN_SIGN_IN_CHAIN_ID) return bad("sign in on Base");
  let canonical: string;
  try {
    canonical = buildAdminSignInMessage({ origin, address: m.address, nonce: m.nonce, issuedAt: m.issuedAt });
  } catch {
    return bad("bad sign-in message");
  }
  if (canonical !== message) return bad("bad sign-in message");
  const issued = m.issuedAt.getTime();
  if (issued > opts.now + CLOCK_SKEW_MS) return bad("your clock is ahead: check the time on this device");
  if (opts.now - issued >= ADMIN_MESSAGE_TTL_MS) return bad("sign-in expired, try again");
  return { ok: true, wallet: m.address.toLowerCase(), nonce: m.nonce };
}

/** Plain words for a session's device: browser · OS, from the user agent (no versions; the agent itself is never kept). */
export function deviceLabel(ua: string | null | undefined): string {
  const s = ua ?? "";
  const browser = /Edg\//.test(s) ? "Edge" : /OPR\/|Opera/.test(s) ? "Opera" : /Firefox\/|FxiOS/.test(s) ? "Firefox" : /Chrome\/|CriOS/.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : "";
  const os = /iPhone|iPad|iPod/.test(s) ? "iOS" : /Android/.test(s) ? "Android" : /Mac OS X|Macintosh/.test(s) ? "macOS" : /Windows/.test(s) ? "Windows" : /Linux|X11/.test(s) ? "Linux" : "";
  return [browser, os].filter(Boolean).join(" · ") || "Unknown device";
}
