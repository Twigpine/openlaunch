import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";
import { clientTranslator } from "@/i18n/client";

/** Contract errors with their own friendly wording (the errors area's `contract` messages). */
const CONTRACT_ERRORS = ["SaltUsed", "BadFee", "BadTick", "BadSupply", "QuoteOrdering", "NativeQuoteUnsupported", "NoLiquidity", "UnknownPosition", "BadRecipients"] as const;
type ContractError = (typeof CONTRACT_ERRORS)[number];
const isContractError = (name: string): name is ContractError => (CONTRACT_ERRORS as readonly string[]).includes(name);

/**
 * Friendly wallet / contract error text for the UI, in the reader's language (English on the server and in tests).
 * `slippagePct` = the tolerance the failed call actually used (the trade panel's 1% by default).
 */
export function friendlyError(err: unknown, opts: { slippagePct?: number } = {}): string {
  const t = clientTranslator("errors");
  // a string, so the percentage reads exactly as written (no locale rounding or grouping)
  const percent = String(opts.slippagePct ?? 1);
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return t("cancelled");
    const rev = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = rev?.data?.errorName;
    const slippage = /slippage|amountOutMinimum|TooLittleReceived/i;
    // an Earn withdrawal larger than what the vault's markets have free (Morpho's "insufficient liquidity")
    if (/insufficient liquidity/i.test(`${rev?.reason ?? ""} ${err.shortMessage || err.message}`)) return t("insufficientLiquidity");
    if (name && isContractError(name)) return t(`contract.${name}`);
    if (name && slippage.test(name)) return t("slippage", { percent }); // decoded router error (e.g. V4TooLittleReceived)
    if (name) return t("reverted", { name });
    const short = err.shortMessage || err.message;
    if (/insufficient funds/i.test(short)) return t("gas");
    if (slippage.test(short)) return t("slippage", { percent });
    return short.length > 200 ? `${short.slice(0, 200)}…` : short;
  }
  if (err instanceof Error) return err.message;
  return t("unknown");
}
