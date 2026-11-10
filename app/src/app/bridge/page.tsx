import type { Metadata } from "next";
import { ArrowDown, ArrowLeftRight } from "lucide-react";
import { pageMetadata } from "@/lib/seo";
import SectionIntro from "@/components/sections/SectionIntro";
import shell from "@/components/sections/SectionShell.module.css";
import BridgePageSlot from "@/components/bridge/BridgePageSlot";
import BridgeHistory from "@/components/bridge/BridgeHistory";
import { parseBridgeLink } from "@/lib/bridge/link";
import { BRIDGE_CHAINS, BRIDGE_DESTINATION_IDS, BRIDGE_FUNDING_IDS, BRIDGE_RECEIVE_ASSETS, BRIDGE_SEND_ASSETS, type BridgeChainId } from "@/lib/bridge/types";
import styles from "./bridge.module.css";

/**
 * The bridge as a page: the same panel the header opens, with room for the facts beside it. The panel is rendered by
 * the header's one bridge controller into the slot below (components/bridge/bridge-slot.ts), so this page starts no
 * second copy. `?from=…&to=…&asset=…&toAsset=…` preselects a route (lib/bridge/link.ts) and nothing more.
 */
export const metadata: Metadata = pageMetadata({
  path: "/bridge",
  title: "Bridge",
  description: "Move ETH and dollars between Base, Robinhood Chain, Arc and Elysium, or fund them from Ethereum, Arbitrum and Optimism. Same wallet, no openlaunch fee.",
});

/** A launch chain's assets: what it sends and receives, then what it only receives (HYPE on Elysium). */
function launchAssets(id: BridgeChainId) {
  const both = BRIDGE_SEND_ASSETS[id].filter((asset) => BRIDGE_RECEIVE_ASSETS[id].includes(asset));
  const receiveOnly = BRIDGE_RECEIVE_ASSETS[id].filter((asset) => !BRIDGE_SEND_ASSETS[id].includes(asset));
  return <>
    <dd>{both.join(", ")}<span>Send and receive</span></dd>
    {receiveOnly.length > 0 ? <dd>{receiveOnly.join(", ")}<span>Receive only</span></dd> : null}
  </>;
}

const STEPS = [
  ["Pick a route and an amount", "A live quote appears with the fee, the gas and the least you will receive. Nothing is asked of your wallet yet."],
  ["Approve, for tokens only", "USDC and USDG need an approval for the exact amount first. It is its own wallet step and moves nothing. ETH skips it."],
  ["Confirm the deposit", "Slide the coin across or press the button, then confirm in your wallet. This is the one step that sends funds."],
  ["Watch it arrive", "The board follows the transfer until the provider confirms delivery to the same address on the other network."],
] as const;

export default async function BridgePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const link = parseBridgeLink(await searchParams);
  return (
    <main className={shell.page}>
      <SectionIntro
        eyebrow="Bridge"
        icon={<ArrowLeftRight />}
        title="Move funds to where you launch"
        description="Send ETH and dollars between Base, Robinhood Chain, Arc and Elysium, or bring them in from Ethereum, Arbitrum and Optimism. They arrive at the same wallet address. openlaunch charges nothing for it."
      >
        <a href="#transfers" className={shell.textLink}>Your transfers <ArrowDown size={14} aria-hidden="true" /></a>
      </SectionIntro>
      <div className={styles.layout}>
        <BridgePageSlot link={link} />
        <div className={styles.facts}>
          <section aria-labelledby="bridge-networks">
            <h2 id="bridge-networks">Networks and tokens</h2>
            <dl className={styles.networks}>
              {BRIDGE_DESTINATION_IDS.map((id) => <div key={id}><dt>{BRIDGE_CHAINS[id].name}</dt>{launchAssets(id)}</div>)}
              {BRIDGE_FUNDING_IDS.map((id) => <div key={id}><dt>{BRIDGE_CHAINS[id].name}</dt><dd>{BRIDGE_SEND_ASSETS[id].join(", ")}<span>Send only</span></dd></div>)}
            </dl>
          </section>
          <section aria-labelledby="bridge-steps">
            <h2 id="bridge-steps">How a transfer goes</h2>
            <ol className={styles.steps}>
              {STEPS.map(([title, body]) => <li key={title}><strong>{title}</strong><span>{body}</span></li>)}
            </ol>
          </section>
          <section aria-labelledby="bridge-costs">
            <h2 id="bridge-costs">What it costs</h2>
            <ul className={styles.points}>
              <li>openlaunch takes no fee on a transfer.</li>
              <li>The bridge provider charges a fee that is shown before you confirm and is already taken out of the amount you receive.</li>
              <li>Relay quotes every route. For USDC to USDC into Base or Arc, Circle is quoted too, and you get whichever delivers more. The quote names which one.</li>
              <li>Gas on the network you send from is extra.</li>
              <li>A quote that would cost more than 5% in fees, or lose more than 5% in conversion, is blocked.</li>
            </ul>
          </section>
          <section aria-labelledby="bridge-know">
            <h2 id="bridge-know">Good to know</h2>
            <ul className={styles.points}>
              <li>Elysium sends USDC only. Its gas token, HYPE, can be received there but not sent, so receive a little HYPE first if you have none to pay gas on Elysium.</li>
              <li>Funds on an exchange? The panel&apos;s exchange guide shows where to withdraw them (Base, Ethereum, Arbitrum or Optimism), watches for them to land, then opens the bridge on that route.</li>
              <li>Funds go from your wallet to Relay&apos;s deposit contract, or to Circle&apos;s transfer contract on a Circle route. They never pass through an openlaunch wallet or contract.</li>
              <li>Relay and Circle are third parties. openlaunch operates neither and cannot reverse a transfer.</li>
              <li>A transfer is saved in this browser while it is in progress. Reopen the bridge with the same wallet to pick it up.</li>
              <li>Finished transfers stay on the board below. It never asks your wallet for anything.</li>
            </ul>
          </section>
        </div>
      </div>
      <BridgeHistory />
    </main>
  );
}
