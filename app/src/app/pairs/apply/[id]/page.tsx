import type { Metadata } from "next";
import { CHAIN_LABELS } from "@/lib/chainPublic";
import { notFound } from "next/navigation";
import SectionIntro from "@/components/sections/SectionIntro";
import shell from "@/components/sections/SectionShell.module.css";
import PairApplication from "@/components/launchpad/PairApplication";
import { applicationsOpen, getApplication } from "@/lib/launchpad/pairApplyServer";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Community pair application", robots: { index: false, follow: false } };

export default async function PairApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const app = await getApplication(Number(id));
  if (!app) notFound();
  return (
    <main className={shell.page}>
      <SectionIntro eyebrow="Community pair application" title={`${app.name} (${app.symbol})`} description={`Application ${app.code}, for a token on ${CHAIN_LABELS[app.chain]}. Every step below is public: the check, the fee and the decision.`} />
      <div className="mt-8 max-w-2xl">
        <PairApplication initial={app} open={applicationsOpen()} />
      </div>
    </main>
  );
}
