import { en, type Messages } from "@/i18n/messages/en";

export type EarnReason = keyof Messages["earn"]["reasons"];
type Translate = (key: EarnReason, values?: Record<string, string>) => string;

/**
 * Why Earn cannot go ahead, or what became of a send, as messages (earn.reasons). The reasons arrive as English text
 * from lib/earn (depositProblem and withdrawProblem in math.ts, termsCheck and pausedCopy in terms.ts, phase.ts,
 * calls.ts), from useEarn's own stops and throws, and from the server's terms check, which the card receives already
 * worded. Each English message reads exactly as its reason, so the reason finds its message; the libs keep their
 * English. friendlyError's reasons arrive in the reader's language already, and anything else (a wallet's own error)
 * reads as it came. Server-safe and pure, so the tests can read every reason back.
 */
const EXACT = new Map(
  Object.entries(en.earn.reasons)
    .filter(([, text]) => !text.includes("{"))
    .map(([key, text]) => [text, key as EarnReason]),
);

/** The reasons with a value in them, read back from their English wording. */
const WITH_VALUES: readonly [RegExp, EarnReason, (m: RegExpExecArray) => Record<string, string>][] = [
  [/^The vault no longer takes (\S+)\.$/, "asset", (m) => ({ symbol: m[1] })],
  [/^The vault now keeps (\S+) of the interest it earns\.$/, "performanceFee", (m) => ({ fee: m[1] })],
  [/^The vault now charges a (\S+) yearly management fee\.$/, "managementFee", (m) => ({ fee: m[1] })],
];

/** pausedCopy's sentence, around the reason it carries. */
const PAUSED = /^Deposits are paused here: (.+) openlaunch listed this vault without that and has not reviewed the change\. Withdrawals stay open\.$/;

/** A reason in the reader's language: its message when it is one Earn gives, otherwise the text as it came. */
export function explainEarn(reason: string, t: Translate): string {
  const paused = PAUSED.exec(reason);
  if (paused) return t("paused", { reason: explainEarn(paused[1], t) });
  const key = EXACT.get(reason);
  if (key) return t(key);
  for (const [pattern, withValues, values] of WITH_VALUES) {
    const m = pattern.exec(reason);
    if (m) return t(withValues, values(m));
  }
  return reason;
}
