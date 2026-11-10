import type { Metadata } from "next";
import { ArrowLeftRight } from "lucide-react";
import { pageMetadata } from "@/lib/seo";
import SectionIntro from "@/components/sections/SectionIntro";
import shell from "@/components/sections/SectionShell.module.css";
import BridgePageSlot from "@/components/bridge/BridgePageSlot";
import BridgeHistory from "@/components/bridge/BridgeHistory";
import { parseBridgeLink } from "@/lib/bridge/link";
import { BRIDGE_ASSETS, BRIDGE_CHAINS, BRIDGE_DESTINATION_IDS, BRIDGE_FUNDING_IDS } from "@/lib/bridge/types";
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
      />
      <div className={styles.layout}>
        <BridgePageSlot link={link} />
        <div className={styles.facts}>
          <section aria-labelledby="bridge-networks">
            <h2 id="bridge-networks">Networks and tokens</h2>
            <dl className={styles.networks}>
              {BRIDGE_DESTINATION_IDS.map((id) => <div key={id}><dt>{BRIDGE_CHAINS[id].name}</dt><dd>{BRIDGE_ASSETS[id].join(", ")}<span>Send and receive</span></dd></div>)}
              {BRIDGE_FUNDING_IDS.map((id) => <div key={id}><dt>{BRIDGE_CHAINS[id].name}</dt><dd>{BRIDGE_ASSETS[id].join(", ")}<span>Send only</span></dd></div>)}
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
              <li>On Elysium the bridge carries USDC only. Its gas token, HYPE, is not bridged, so keep some HYPE there to use or send what arrives.</li>
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
