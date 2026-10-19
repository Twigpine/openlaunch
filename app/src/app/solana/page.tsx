import Link from "next/link";
import { configuredSolana, solanaRpcUrl } from "@/lib/solana/server";
import SolanaWorkspace from "@/components/solana/SolanaWorkspace";
import { btn } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Solana workspace",
  robots: { index: false, follow: false },
};

export default function SolanaPage() {
  const config = configuredSolana();
  if (config && solanaRpcUrl()) return <SolanaWorkspace config={config} />;
  return (
    <main className="mx-auto max-w-3xl px-5 py-12 sm:py-20">
      <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
        Solana, with no admin controls.
      </h1>
      <p className="mt-4 max-w-xl text-base leading-relaxed text-body">
        The native launch-pool integration is under review. It is separate from
        the live launchpad and cannot accept funds here yet.
      </p>
      <section
        className="my-8 border-y border-line py-6"
        aria-labelledby="release-gates"
      >
        <h2 id="release-gates" className="text-lg font-semibold text-ink">
          Before launches open
        </h2>
        <ul className="mt-4 space-y-3 text-sm leading-relaxed text-body">
          <li>
            Independent security and economic review of the exact program.
          </li>
          <li>
            Verified deployment with the upgrade authority permanently removed.
          </li>
          <li>
            Launch, buy, sell, fee-claim and wallet recovery rehearsal on the
            deployed program.
          </li>
        </ul>
      </section>
      <p className="mb-6 text-sm text-muted">
        Existing Base, Robinhood and Arc launches continue unchanged.
      </p>
      <Link href="/" className={btn.secondary}>
        Back to launchpad
      </Link>
    </main>
  );
}
