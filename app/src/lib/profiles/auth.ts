/**
 * Signed profile messages (pure; node --test loads this directly).
 *
 * Every profile write is an EIP-191 signature over one of these messages (smart wallets verify via ERC-1271 /
 * ERC-6492, same as signed edits and posts). Each names the action, the wallet, a client nonce (single use,
 * consumed server-side) and a timestamp (±5 minutes), and spells out every field it changes, so the wallet shows
 * the person exactly what they are signing. Saving a profile with an X handle also starts verification: the code
 * the server hands back is bound to this wallet AND that handle, so it is useless from any other X account.
 */
import type { ProfileFields } from "./validate.ts";

export const PROFILE_DOMAIN = "openlaunch.lol";
export const PROFILE_TS_SKEW_MS = 5 * 60_000;

export function isNonce(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
}

export function tsFresh(ts: unknown, now: number): boolean {
  const n = Number(ts);
  return Number.isFinite(n) && Math.abs(now - n) <= PROFILE_TS_SKEW_MS;
}

const footer = `It costs nothing and moves no funds.`;

export function buildProfileMessage(p: { wallet: string; nonce: string; ts: number; fields: ProfileFields }): string {
  return [
    `${PROFILE_DOMAIN} wants you to save your public profile.`,
    ``,
    `Wallet: ${p.wallet.toLowerCase()}`,
    `Nonce: ${p.nonce}`,
    `Issued: ${new Date(p.ts).toISOString()}`,
    ``,
    `username: ${p.fields.username}`,
    `name: ${p.fields.display_name}`,
    `bio: ${p.fields.bio.replace(/\n/g, " / ")}`,
    `avatar: ${p.fields.avatar_key ?? ""}`,
    `x: ${p.fields.x_handle}`,
    ``,
    `Your username and name appear next to your trades, posts and launches on ${PROFILE_DOMAIN}. ${footer}`,
  ].join("\n");
}

export function buildProfileDeleteMessage(p: { wallet: string; nonce: string; ts: number }): string {
  return [`${PROFILE_DOMAIN} wants you to delete your public profile.`, ``, `Wallet: ${p.wallet.toLowerCase()}`, `Nonce: ${p.nonce}`, `Issued: ${new Date(p.ts).toISOString()}`, ``, `Your trades stay on-chain; only the name next to them goes. ${footer}`].join("\n");
}

export const PROFILE_MOD_ACTIONS = ["approve_x", "reject_x", "hide", "unhide", "exclude_points", "include_points", "reset_username"] as const;
export type ProfileModAction = (typeof PROFILE_MOD_ACTIONS)[number];
export function isProfileModAction(v: unknown): v is ProfileModAction {
  return typeof v === "string" && (PROFILE_MOD_ACTIONS as readonly string[]).includes(v);
}

export function buildProfileModMessage(p: { action: ProfileModAction; target: string; wallet: string; nonce: string; ts: number; reason?: string }): string {
  return [`${PROFILE_DOMAIN} moderation`, ``, `Action: ${p.action}`, `Profile: ${p.target.toLowerCase()}`, `Reason: ${p.reason ?? ""}`, `Admin: ${p.wallet.toLowerCase()}`, `Nonce: ${p.nonce}`, `Issued: ${new Date(p.ts).toISOString()}`].join("\n");
}
