import { notFound } from "next/navigation";
import SolanaWorkspace from "@/components/solana/SolanaWorkspace";
import { configuredSolana, solanaRpcUrl } from "@/lib/solana/server";
import { publicKey } from "@/lib/solana/config";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Solana pool",
  robots: { index: false, follow: false },
};
export default async function PoolPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  const config = configuredSolana();
  if (!config || !solanaRpcUrl() || !publicKey(address)) notFound();
  return <SolanaWorkspace config={config} initialPool={address} />;
}
