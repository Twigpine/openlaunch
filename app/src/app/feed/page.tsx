import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";
import Link from "next/link";
import { ArrowUpRight, MessagesSquare } from "lucide-react";
import CommunityFeed from "@/components/sections/CommunityFeed";
import SectionIntro from "@/components/sections/SectionIntro";
import styles from "@/components/sections/SectionShell.module.css";
import { listFeed } from "@/lib/launchpad/postsServer";
import { getTranslations } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("posts");
  return pageMetadata({ path: "/feed", title: t("page.meta.title"), description: t("page.meta.description") });
}

export const dynamic = "force-dynamic";

export default async function FeedPage() {
  const result = await listFeed(100).then((posts) => ({ posts, failed: false })).catch(() => ({ posts: [], failed: true }));
  const t = await getTranslations("posts");
  return (
    <main className={styles.page}>
      <SectionIntro eyebrow={t("page.eyebrow")} icon={<MessagesSquare />} title={t("page.title")} description={t("page.description")}>
        <Link href="/#launches" className={styles.action}>{t("page.explore")} <ArrowUpRight size={16} aria-hidden="true" /></Link>
      </SectionIntro>
      <CommunityFeed initial={result.posts} loadError={result.failed} />
    </main>
  );
}
