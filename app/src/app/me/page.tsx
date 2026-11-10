import type { Metadata } from "next";
import MeDashboard from "@/components/launchpad/MeDashboard";
import { LayoutDashboard } from "lucide-react";
import SectionIntro from "@/components/sections/SectionIntro";
import shell from "@/components/sections/SectionShell.module.css";
import { getTranslations } from "@/i18n/server";

// Wallet-specific: the page is empty for a crawler, so it stays out of the index (and out of the sitemap).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("account");
  return { title: t("me.title"), description: t("me.description"), robots: { index: false, follow: true } };
}
export const dynamic = "force-dynamic";

export default async function MePage() {
  const t = await getTranslations("account");
  return (
    <main className={shell.page}>
      <SectionIntro eyebrow={t("me.eyebrow")} icon={<LayoutDashboard />} title={t("me.heading")} description={t("me.intro")} />
      <MeDashboard />
    </main>
  );
}
