import type { Metadata } from "next";
import { cookies } from "next/headers";
import { cache } from "react";
import AdminQueue from "@/components/launchpad/AdminQueue";
import ProfileQueue from "@/components/profile/ProfileQueue";
import PointsAdmin from "@/components/points/PointsAdmin";
import BoostAdmin from "@/components/launchpad/BoostAdmin";
import PairsAdmin from "@/components/launchpad/PairsAdmin";
import PairReviewAdmin from "@/components/launchpad/PairReviewAdmin";
import AdminSignIn from "@/components/admin/AdminSignIn";
import AdminSessionBar from "@/components/admin/AdminSessionBar";
import { AdminWalletProvider } from "@/components/admin/AdminAccount";
import { ADMIN_COOKIE, adminSessionFromToken } from "@/lib/admin/session";

export const dynamic = "force-dynamic";

/** This request's admin session, read once per request. A failed read is no session: the page fails closed. */
const currentAdmin = cache(async () => {
  try {
    return await adminSessionFromToken((await cookies()).get(ADMIN_COOKIE)?.value);
  } catch (err) {
    console.error("[admin] session read failed:", err instanceof Error ? err.message : err);
    return null;
  }
});

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await currentAdmin()) ? "Moderation" : "Sign in", robots: { index: false, follow: false } };
}

/**
 * The moderation page. Without an admin session it is only the sign-in card: no panel and no admin data is rendered.
 * With one: reported posts, the profiles queue, season points, the Boosted lane and community pairs, each action a
 * signature from the signed-in admin wallet as well.
 */
export default async function AdminPage() {
  const admin = await currentAdmin();
  if (!admin) {
    return (
      <main className="mx-auto max-w-md px-4 pt-12 sm:pt-16 pb-16">
        <AdminSignIn />
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-3xl px-4 pt-8 sm:pt-10 pb-16 space-y-6">
      <header>
        <h1 className="font-display font-bold tracking-[-0.02em] text-ink text-3xl">Moderation</h1>
        <p className="mt-2 text-base text-body">Reported posts, profiles, season points, the Boosted lane and community pairs. Every action is a signature from the signed-in admin wallet.</p>
      </header>
      <AdminSessionBar wallet={admin.wallet} expiresAt={admin.expiresAt} id={admin.id} />
      <AdminWalletProvider wallet={admin.wallet}>
        <AdminQueue />
        <ProfileQueue />
        <PointsAdmin />
        <BoostAdmin />
        <PairsAdmin />
        <PairReviewAdmin />
      </AdminWalletProvider>
    </main>
  );
}
