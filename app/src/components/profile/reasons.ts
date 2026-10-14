import { en, type Messages } from "@/i18n/messages/en";

export type Reason = keyof Messages["account"]["profileSheet"]["errors"];

/**
 * Why a profile save, delete or X check failed, as messages (account.profileSheet.errors). The reasons arrive as
 * English text from validateProfile (lib/profiles/validate.ts, the X field's from lib/launchpad/xHandle.ts), the profile
 * API (lib/profiles/server.ts, xpost.ts and the /api/profile routes) and ProfileSheet's own fallbacks. Each English
 * message reads exactly as its reason, so the reason finds its message; the libs and the API keep their English.
 * friendlyError (lib/errors.ts) already words its reasons in the reader's language. Server-safe and pure, so the tests
 * can read every reason back.
 */
const EXACT = new Map(
  Object.entries(en.account.profileSheet.errors)
    .filter(([, text]) => !text.includes("{"))
    .map(([key, text]) => [text, key as Reason]),
);

/** The reasons with a value in them, read back from their English wording. */
const WITH_VALUES: readonly [RegExp, Reason, (m: RegExpExecArray) => Record<string, string>][] = [
  [/^your wallet lives on (.+): switch your wallet to \1 and sign again$/, "walletChain", (m) => ({ chain: m[1] })],
  [/^that post is from @(\w+), but this code is for @(\w+)$/, "wrongAccount", (m) => ({ handle: m[1], expected: m[2] })],
  [/^the code (\S+) is not in that post$/, "codeMissing", (m) => ({ code: m[1] })],
  [/^X did not answer just now, and that link is not a post from @(\w+): paste the link to your post from @\1, or try again in a minute$/, "xDownWrongLink", (m) => ({ handle: m[1] })],
];

/** The message for a failure reason and the values in it, or null for text it does not know (a wallet's own error). */
export function reasonOf(reason: string): { key: Reason; values?: Record<string, string> } | null {
  const key = EXACT.get(reason);
  if (key) return { key };
  for (const [pattern, withValues, values] of WITH_VALUES) {
    const m = pattern.exec(reason);
    if (m) return { key: withValues, values: values(m) };
  }
  return null;
}
