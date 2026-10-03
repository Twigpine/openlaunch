import type { Metadata } from "next";
import MeDashboard from "@/components/launchpad/MeDashboard";
import SectionIntro from "@/components/sections/SectionIntro";
import shell from "@/components/sections/SectionShell.module.css";

// Wallet-specific: the page is empty for a crawler, so it stays out of the index (and out of the sitemap).
export const metadata: Metadata = { title: "Me", description: "Your launches, fees, holdings and trades on Base, Robinhood Chain and Arc.", robots: { index: false, follow: true } };
export const dynamic = "force-dynamic";

export default function MePage() {
  return (
    <main className={shell.page}>
      <SectionIntro eyebrow="Your dashboard" title="A space for your next move." description="Your launches, the fees they earn, and everything you trade. One wallet across Base, Robinhood Chain and Arc." />
      <MeDashboard />
    </main>
  );
}
