import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import CommunityFeed from "@/components/sections/CommunityFeed";
import SectionIntro from "@/components/sections/SectionIntro";
import styles from "@/components/sections/SectionShell.module.css";
import { listFeed } from "@/lib/launchpad/postsServer";

export const metadata: Metadata = pageMetadata({ path: "/feed", title: "Posts", description: "What people are saying about tokens launched on openlaunch.lol." });
export const dynamic = "force-dynamic";

export default async function FeedPage() {
  const result = await listFeed(100).then((posts) => ({ posts, failed: false })).catch(() => ({ posts: [], failed: true }));
  return (
    <main className={styles.page}>
      <SectionIntro eyebrow="Community / Posts" title="Behind every token." description="Holders, traders and creators, in their own words. Follow the conversation across Base, Robinhood Chain and Arc.">
        <Link href="/#launches" className={styles.action}>Explore tokens <ArrowUpRight size={16} aria-hidden="true" /></Link>
      </SectionIntro>
      <CommunityFeed initial={result.posts} loadError={result.failed} />
    </main>
  );
}
