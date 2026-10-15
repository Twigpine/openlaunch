import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";

/** Friendly wallet / contract error text for the UI. */
const CONTRACT_ERROR_MESSAGES: Record<string, string> = {
  SaltUsed: "This salt was already used. Try again (a fresh salt is generated).",
  BadFee: "Fee out of range (max 3%).",
  BadTick: "Start price out of range.",
  BadSupply: "Supply too large.",
  QuoteOrdering: "Token address must sort above the quote. Try again with a new salt.",
  NativeQuoteUnsupported: "This chain does not take its native asset as a quote. Price the token in USDC instead.",
  NoLiquidity: "Supply too small to seed liquidity.",
  UnknownPosition: "Unknown launch.",
  BadRecipients: "Beneficiary shares must add up to 100%.",
};

/** `slippagePct` = the tolerance the failed call actually used (the trade panel's 1% by default). */
export function friendlyError(err: unknown, opts: { slippagePct?: number } = {}): string {
  const slippagePct = opts.slippagePct ?? 1;
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return "You cancelled in your wallet.";
    const rev = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = rev?.data?.errorName;
    const slippage = /slippage|amountOutMinimum|TooLittleReceived/i;
    // an Earn withdrawal larger than what the vault's markets have free (Morpho's "insufficient liquidity")
    if (/insufficient liquidity/i.test(`${rev?.reason ?? ""} ${err.shortMessage || err.message}`)) return "The vault cannot pay out that much right now: most of it is lent out. Try a smaller amount, or try again later.";
    if (name && CONTRACT_ERROR_MESSAGES[name]) return CONTRACT_ERROR_MESSAGES[name];
    if (name && slippage.test(name)) return `Price moved more than ${slippagePct}%. Try again.`; // decoded router error (e.g. V4TooLittleReceived)
    if (name) return `Reverted: ${name}`;
    const short = err.shortMessage || err.message;
    if (/insufficient funds/i.test(short)) return "Not enough of the gas token (ETH, or USDC on Arc) for this transaction plus gas.";
    if (slippage.test(short)) return `Price moved more than ${slippagePct}%. Try again.`;
    return short.length > 200 ? `${short.slice(0, 200)}…` : short;
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
