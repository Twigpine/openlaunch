"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { BadgeCheck, PencilLine, UserRound } from "lucide-react";
import { XMark } from "@/components/launchpad/BrandMarks";
import { shortAddr } from "@/lib/chainPublic";
import type { PublicProfile } from "@/lib/profiles/server";
import ProfileSheet, { loadCode } from "./ProfileSheet";
import { VerifiedTick, WhoAvatar } from "./Who";

/**
 * The connected wallet as a person on /me: avatar, name and username when there is a profile (with the X state),
 * otherwise the address and a "Create profile" button. Opens ProfileSheet for every change.
 */
export default function ProfileIdentity({ address, avatarClass, labelClass, addressClass }: { address: string; avatarClass?: string; labelClass?: string; addressClass?: string }) {
  const [profile, setProfile] = useState<PublicProfile | null | undefined>(undefined);
  const [open, setOpen] = useState<null | "edit" | "verify">(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/profile?wallet=${address}`, { cache: "no-store" });
      if (r.status === 404) return setProfile(null);
      if (!r.ok) return;
      setProfile(((await r.json()) as { profile: PublicProfile }).profile);
    } catch {
      /* keep what we have */
    }
  }, [address]);
  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const xState = profile?.x_state ?? "none";
  return (
    <>
      <div className="flex min-w-0 items-center gap-3">
        <span className={avatarClass} aria-hidden="true"><WhoAvatar address={address} size={40} /></span>
        <div className="min-w-0">
          {profile ? (
            <>
              <p className={labelClass}>
                <Link href={`/u/${profile.username}`} className="hover:underline underline-offset-2">openlaunch.lol/u/{profile.username}</Link>
              </p>
              <span className="flex min-w-0 items-center gap-1.5 text-[15px] font-semibold text-ink">
                <span className="truncate">{profile.display_name}</span>
                {xState === "verified" ? <VerifiedTick size={15} /> : null}
                <span className="truncate font-normal text-muted">{profile.username}</span>
              </span>
            </>
          ) : (
            <>
              <p className={labelClass}>Connected wallet</p>
              <span className={addressClass} title={address}>{shortAddr(address)}</span>
            </>
          )}
        </div>
        {profile === undefined ? null : profile ? (
          <div className="ml-1 flex shrink-0 flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => setOpen("edit")} className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-line px-3 text-[13px] font-medium text-body hover:border-line-strong hover:text-ink"><PencilLine size={14} aria-hidden="true" />Edit</button>
            {xState !== "verified" ? (
              <button type="button" onClick={() => setOpen(loadCode(address) ? "verify" : "edit")} className="inline-flex min-h-9 items-center gap-1.5 rounded-xl bg-brand-soft px-3 text-[13px] font-semibold text-brand hover:bg-brand hover:text-inverse">
                {xState === "pending" ? <><BadgeCheck size={14} aria-hidden="true" />Being checked</> : xState === "reverify" ? <><XMark />Verify again</> : <><XMark />Verify with X</>}
              </button>
            ) : null}
          </div>
        ) : (
          <button type="button" onClick={() => setOpen("edit")} className="ml-1 inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-xl bg-brand px-3.5 text-[13px] font-semibold text-inverse hover:bg-brand-strong"><UserRound size={14} aria-hidden="true" />Create profile</button>
        )}
      </div>
      {open ? <ProfileSheet address={address} initial={profile ?? null} startOnVerify={open === "verify"} onClose={() => setOpen(null)} onSaved={(p) => setProfile(p)} /> : null}
    </>
  );
}
