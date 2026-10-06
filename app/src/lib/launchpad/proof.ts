import type { HolderPanel } from "./holdersServer";
import { SNIPER_BLOCKS, fmtShare } from "./holders.ts";
import { pipsToPct } from "./math.ts";

/**
 * The token page's Proof panel: five facts, each read from the chain or the launch transaction, worded plainly
 * and never scored. `tone` only says which facts deserve a second look (the same thresholds as the holders panel).
 * Holder facts are left out until the transfer history is indexed: missing data is not a clean bill of health.
 */
export type ProofKey = "lock" | "creator" | "spread" | "launch" | "fees";
export type ProofFact = { key: ProofKey; tone: "good" | "info" | "warn"; title: string; detail: string };
export type FeeMode = "free" | "burn" | "creator" | "split";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n.toLocaleString("en-US")} times`);

export function proofFacts({ holders, symbol, launcher, lpFee, mode, recipients }: {
  holders: Pick<HolderPanel, "synced" | "holders" | "top10Bps" | "poolBps" | "creator" | "sniper"> | null;
  symbol: string;
  launcher: string;
  lpFee: number;
  mode: FeeMode;
  recipients: number;
}): { facts: ProofFact[]; holdersReady: boolean } {
  const ready = holders?.synced === true;
  const facts: ProofFact[] = [];

  facts.push({
    key: "lock",
    tone: "good",
    title: "Liquidity is locked forever",
    detail: ready
      ? `${fmtShare(holders!.poolBps)} of the supply is in the locked Uniswap v4 pool. No wallet can withdraw the position, including the creator and openlaunch.`
      : "The pool position sits in an ownerless locker. No wallet can withdraw it, including the creator and openlaunch.",
  });

  if (ready) {
    const h = holders!;
    const { bps, sells } = h.creator;
    const bought = BigInt(h.creator.bought);
    facts.push(bps === 0 && sells === 0 && bought === 0n
      ? { key: "creator", tone: "good", title: "The creator holds none", detail: `${short(launcher)} has never bought or sold ${symbol}.` }
      : bps === 0
        ? { key: "creator", tone: sells > 0 ? "warn" : "info", title: "The creator holds none now", detail: sells > 0 ? `${short(launcher)} sold ${times(sells)} and holds no ${symbol}.` : `${short(launcher)} bought and no longer holds ${symbol}.` }
        : { key: "creator", tone: bps >= 2_000 || sells > 0 ? "warn" : "info", title: `The creator holds ${fmtShare(bps)}`, detail: sells > 0 ? `${short(launcher)} has sold ${times(sells)}.` : `${short(launcher)} has not sold any.` });

    facts.push({
      key: "spread",
      tone: h.top10Bps >= 5_000 ? "warn" : "info",
      title: plural(h.holders, "holder"),
      detail: h.holders === 0 ? `Nobody holds ${symbol} outside the pool yet.` : h.holders <= 10
        ? `Together they hold ${fmtShare(h.top10Bps)} of the supply.`
        : `The ten largest hold ${fmtShare(h.top10Bps)} of the supply between them.`,
    });

    const window = `the launch block or the ${SNIPER_BLOCKS} blocks after it`;
    facts.push(h.sniper.wallets === 0
      ? { key: "launch", tone: "good", title: "Nobody bought at launch", detail: `No wallet bought in ${window}.` }
      : { key: "launch", tone: h.sniper.bps >= 1_000 ? "warn" : "info", title: `${plural(h.sniper.wallets, "wallet")} bought at launch`, detail: `${h.sniper.wallets === 1 ? "It" : "They"} took ${fmtShare(h.sniper.bps)} of the supply in ${window}.` });
  }

  const fixed = "openlaunch takes 0%. Fee routing was set in the launch transaction and can never change.";
  const pct = pipsToPct(lpFee);
  facts.push(mode === "free"
    ? { key: "fees", tone: "good", title: "No trading fee", detail: `Trades pay only the network's gas. ${fixed}` }
    : mode === "burn"
      ? { key: "fees", tone: "info", title: `${pct} trading fee, burned`, detail: `Every fee goes to 0x…dEaD. ${fixed}` }
      : { key: "fees", tone: "info", title: `${pct} trading fee, to the ${recipients === 1 ? "recipient" : "recipients"} set at launch`, detail: `${recipients === 1 ? "One wallet receives" : `${plural(recipients, "wallet")} share`} it. ${fixed}` });

  return { facts, holdersReady: ready };
}
