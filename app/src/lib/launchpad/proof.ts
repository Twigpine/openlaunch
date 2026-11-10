import { createTranslator } from "use-intl/core";
import type { HolderPanel } from "./holdersServer";
import { SNIPER_BLOCKS, fmtShare } from "./holders.ts";
import { pipsToPct } from "./math.ts";
import { messagesFor } from "../../i18n/messages/index.ts";
import type { Locale } from "../../i18n/locales.ts";

/**
 * The token page's Proof panel: five facts, each read from the chain or the launch transaction, worded plainly
 * and never scored. `tone` only says which facts deserve a second look (the same thresholds as the holders panel).
 * Holder facts are left out until the transfer history is indexed: missing data is not a clean bill of health.
 */
export type ProofKey = "lock" | "creator" | "spread" | "launch" | "fees";
export type ProofFact = { key: ProofKey; tone: "good" | "info" | "warn"; title: string; detail: string };
export type FeeMode = "free" | "burn" | "creator" | "split";

/** A short address for proof lines. */
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * The proof panel's facts for a token (lock, fees, creator holdings, snipers), naming the creator by username when they
 * have a profile. Worded in `locale` (the token area's proof messages), English unless the page says otherwise.
 */
export function proofFacts({ holders, symbol, launcher, launcherName, lpFee, mode, recipients, locale = "en" }: {
  holders: Pick<HolderPanel, "synced" | "holders" | "top10Bps" | "poolBps" | "creator" | "sniper"> | null;
  symbol: string;
  launcher: string;
  /** the creator's profile username, when they have one: the facts then name them instead of the short address */
  launcherName?: string | null;
  lpFee: number;
  mode: FeeMode;
  recipients: number;
  /** the reader's language */
  locale?: Locale;
}): { facts: ProofFact[]; holdersReady: boolean } {
  const t = createTranslator({ locale, messages: messagesFor(locale), namespace: "token.proof.facts", timeZone: "UTC" });
  const ready = holders?.synced === true;
  const who = launcherName || short(launcher);
  const facts: ProofFact[] = [];

  facts.push({
    key: "lock",
    tone: "good",
    title: t("lockTitle"),
    detail: ready ? t("lockDetailReady", { share: fmtShare(holders!.poolBps) }) : t("lockDetail"),
  });

  if (ready) {
    const h = holders!;
    const { bps, sells } = h.creator;
    const bought = BigInt(h.creator.bought);
    facts.push(bps === 0 && sells === 0 && bought === 0n
      ? { key: "creator", tone: "good", title: t("creatorNoneTitle"), detail: t("creatorNeverDetail", { who, symbol }) }
      : bps === 0
        ? { key: "creator", tone: sells > 0 ? "warn" : "info", title: t("creatorNoneNowTitle"), detail: sells > 0 ? t("creatorSoldOutDetail", { who, symbol, count: sells }) : t("creatorBoughtOutDetail", { who, symbol }) }
        : { key: "creator", tone: bps >= 2_000 || sells > 0 ? "warn" : "info", title: t("creatorHoldsTitle", { share: fmtShare(bps) }), detail: sells > 0 ? t("creatorSoldDetail", { who, count: sells }) : t("creatorUnsoldDetail", { who }) });

    facts.push({
      key: "spread",
      tone: h.top10Bps >= 5_000 ? "warn" : "info",
      title: t("spreadTitle", { count: h.holders }),
      detail: h.holders === 0 ? t("spreadNobody", { symbol }) : h.holders <= 10
        ? t("spreadTogether", { share: fmtShare(h.top10Bps) })
        : t("spreadTop", { share: fmtShare(h.top10Bps) }),
    });

    // the launch window: the launch block or the SNIPER_BLOCKS blocks after it
    facts.push(h.sniper.wallets === 0
      ? { key: "launch", tone: "good", title: t("launchNobodyTitle"), detail: t("launchNobodyDetail", { blocks: SNIPER_BLOCKS }) }
      : { key: "launch", tone: h.sniper.bps >= 1_000 ? "warn" : "info", title: t("launchBoughtTitle", { count: h.sniper.wallets }), detail: t("launchBoughtDetail", { count: h.sniper.wallets, share: fmtShare(h.sniper.bps), blocks: SNIPER_BLOCKS }) });
  }

  const fixed = t("feesFixed");
  const pct = pipsToPct(lpFee);
  facts.push(mode === "free"
    ? { key: "fees", tone: "good", title: t("feesFreeTitle"), detail: t("feesFreeDetail", { fixed }) }
    : mode === "burn"
      ? { key: "fees", tone: "info", title: t("feesBurnTitle", { pct }), detail: t("feesBurnDetail", { fixed }) }
      : { key: "fees", tone: "info", title: t("feesPaidTitle", { pct, count: recipients }), detail: t("feesPaidDetail", { count: recipients, fixed }) });

  return { facts, holdersReady: ready };
}
