import type { Metadata } from "next";
import AdminQueue from "@/components/launchpad/AdminQueue";
import ProfileQueue from "@/components/profile/ProfileQueue";

export const metadata: Metadata = { title: "Moderation", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default function AdminPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 pt-8 sm:pt-10 pb-16 space-y-6">
      <header>
        <h1 className="font-display font-bold tracking-[-0.02em] text-ink text-3xl">Moderation</h1>
        <p className="mt-2 text-base text-body">Reported posts and profiles. Every action is a signature from an admin wallet.</p>
      </header>
      <AdminQueue />
      <ProfileQueue />
    </main>
  );
}
