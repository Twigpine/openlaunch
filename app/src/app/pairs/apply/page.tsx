import SectionIntro from "@/components/sections/SectionIntro";
import shell from "@/components/sections/SectionShell.module.css";
import PairApply from "@/components/launchpad/PairApply";
import { pageMetadata } from "@/lib/seo";
import { applicationsOpen } from "@/lib/launchpad/pairApplyServer";
import { PAIR_APPLY_COPY, pairListingUsd } from "@/lib/launchpad/pairApply";

export const metadata = pageMetadata({ path: "/pairs/apply", title: "List your token as a community pair", description: "Check your community's token for free, then apply to have launches on openlaunch paired with it. A person reviews every application." });
export const dynamic = "force-dynamic";

export default function PairApplyPage() {
  const open = applicationsOpen();
  return (
    <main className={shell.page}>
      <SectionIntro eyebrow="Community pairs" title={PAIR_APPLY_COPY.title} description={PAIR_APPLY_COPY.lead} />
      <div className="mt-8 max-w-2xl">{open ? <PairApply feeUsd={pairListingUsd()} /> : <p className="text-sm text-muted">{PAIR_APPLY_COPY.disabled}</p>}</div>
    </main>
  );
}
