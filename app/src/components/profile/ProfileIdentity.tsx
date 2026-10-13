"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BadgeCheck, PencilLine, UserRound } from "lucide-react";
import { XMark } from "@/components/launchpad/BrandMarks";
import { shortAddr } from "@/lib/chainPublic";
import type { PublicProfile } from "@/lib/profiles/server";
import ProfileSheet, { loadCode } from "./ProfileSheet";
import { VerifiedTick, WhoAvatar } from "./Who";

/**
 * The connected wallet as a person on /me: avatar, name and username when there is a profile (with the X state), the
 * address and "hidden by a moderator" when its profile was hidden, otherwise the address and a "Create profile"
 * button. Opens ProfileSheet for every change.
 */
export default function ProfileIdentity({ address, avatarClass, labelClass, addressClass }: { address: string; avatarClass?: string; labelClass?: string; addressClass?: string }) {
  const me = address.toLowerCase();
  // everything here is tagged with the wallet it belongs to: after a switch in the wallet app, the previous wallet's
  // profile, Edit button and open form are never shown or used, and a late answer for it never lands on the new one
  const [loaded, setLoaded] = useState<{ wallet: string; profile: PublicProfile | null; hidden?: boolean } | undefined>(undefined);
  const [openFor, setOpenFor] = useState<{ wallet: string; mode: "edit" | "verify" } | null>(null);
  const profile = loaded?.wallet === me ? loaded.profile : undefined;
  // a moderator hid this wallet's profile: it can't be edited or made again, so the card says so instead of offering
  const hidden = loaded?.wallet === me && Boolean(loaded.hidden);
  const open = openFor?.wallet === me ? openFor.mode : null;
  const setOpen = (mode: "edit" | "verify" | null) => setOpenFor(mode ? { wallet: me, mode } : null);
  // the wallet connected right now: a lookup or a save that finishes for any other wallet is dropped
  const current = useRef(me);
  useEffect(() => {
    current.current = me;
  }, [me]);
  // and only the newest lookup counts: a switch A → B → A (the effect's alive flag), or a save (this counter), makes
  // every lookup still in flight stale
  const latest = useRef(0);
  const keep = (wallet: string, p: PublicProfile | null, hiddenByModerator = false) => {
    if (current.current === wallet) setLoaded({ wallet, profile: p, hidden: hiddenByModerator });
  };
  useEffect(() => {
    let alive = true; // cleared when the wallet changes or the card unmounts: a lookup already sent can no longer land
    const ask = ++latest.current;
    const fresh = () => alive && latest.current === ask;
    let id: ReturnType<typeof setTimeout>;
    // a lookup that fails (not a 404: that is "no profile") is tried again after 2, 5, 15 and 30 s, so the card is
    // never left without its Edit or Create button
    const attempt = async (n: number) => {
      try {
        const r = await fetch(`/api/profile?wallet=${me}`, { cache: "no-store" });
        if (r.status === 404) {
          const d = (await r.json().catch(() => ({}))) as { hidden?: boolean };
          if (fresh()) keep(me, null, d.hidden === true);
          return;
        }
        if (r.ok) {
          const p = ((await r.json()) as { profile: PublicProfile }).profile;
          if (fresh()) keep(me, p);
          return;
        }
      } catch {
        /* offline or a blip: retried below */
      }
      const wait = [2_000, 5_000, 15_000, 30_000][n];
      if (wait !== undefined && fresh()) id = setTimeout(() => void attempt(n + 1), wait);
    };
    id = setTimeout(() => void attempt(0), 0);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [me]);
  const saved = (p: PublicProfile | null) => {
    latest.current++; // a lookup sent before the save would bring back the old fields
    keep(me, p);
  };

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
              <p className={labelClass}>{hidden ? "Profile hidden by a moderator" : "Connected wallet"}</p>
              <span className={addressClass} title={address}>{shortAddr(address)}</span>
            </>
          )}
        </div>
        {profile === undefined ? null : profile ? (
          <div className="ml-1 flex shrink-0 flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => setOpen("edit")} className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-line px-3 text-[13px] font-medium text-body hover:border-line-strong hover:text-ink"><PencilLine size={14} aria-hidden="true" />Edit</button>
            {xState === "pending" ? (
              // a person is deciding on the code that was posted: nothing to do here until then (Edit still works)
              <span className="inline-flex min-h-9 items-center gap-1.5 rounded-xl bg-brand-soft px-3 text-[13px] font-semibold text-brand" title="A person is checking your post. Your ✓ appears once it is approved.">
                <BadgeCheck size={14} aria-hidden="true" />Being checked
              </span>
            ) : xState !== "verified" ? (
              <button type="button" onClick={() => setOpen(loadCode(address) ? "verify" : "edit")} className="inline-flex min-h-9 items-center gap-1.5 rounded-xl bg-brand-soft px-3 text-[13px] font-semibold text-brand hover:bg-brand hover:text-inverse">
                {xState === "reverify" ? <><XMark />Verify again</> : <><XMark />Verify with X</>}
              </button>
            ) : null}
          </div>
        ) : hidden ? (
          // nothing to create or edit: the profile exists and stays hidden until a moderator looks again
          <span className="ml-1 shrink-0 text-[12px] text-muted text-pretty" title="Your profile is hidden everywhere, and it can't be edited while it is.">Hidden</span>
        ) : (
          <button type="button" onClick={() => setOpen("edit")} className="ml-1 inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-xl bg-brand px-3.5 text-[13px] font-semibold text-inverse hover:bg-brand-strong"><UserRound size={14} aria-hidden="true" />Create profile</button>
        )}
      </div>
      {open ? <ProfileSheet address={address} initial={profile ?? null} startOnVerify={open === "verify"} onClose={() => setOpen(null)} onSaved={saved} onDeleted={() => saved(null)} /> : null}
    </>
  );
}
