import ChainLanding, { chainLandingMetadata } from "@/components/launchpad/ChainLanding";

export const dynamic = "force-dynamic";
export const metadata = chainLandingMetadata("elysium");

export default function Page() {
  return <ChainLanding chain="elysium" />;
}
