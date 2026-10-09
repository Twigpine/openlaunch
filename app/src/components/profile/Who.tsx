"use client";

import Link from "next/link";
import { useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { ArrowUpRight, BadgeCheck } from "lucide-react";
import WalletAvatar from "@/components/WalletAvatar";
import { shortAddr } from "@/lib/chainPublic";
import { cachedName, subscribeNames, watchName, type NameEntry } from "@/lib/profiles/names-client";
import { NamesContext } from "./NamesProvider";

/**
 * A wallet's public name. During hydration only server-known names count (NamesProvider), so the server HTML and
 * the first client render always agree; afterwards the browser store fills in the rest in one batched request.
 */
export function useName(address: string | null | undefined): NameEntry | null | undefined {
  const w = address?.toLowerCase() ?? "";
  const seeded = useContext(NamesContext)?.[w];
  const live = useSyncExternalStore(subscribeNames, () => (w ? cachedName(w) : undefined), () => undefined);
  // watched while mounted: asked now (unless fresh), then kept current by the store's shared refresher
  useEffect(() => (w ? watchName(w) : undefined), [w]);
  return live !== undefined ? live : seeded;
}

/** The ✓ only a verified X post earns. */
export function VerifiedTick({ size = 13, className = "" }: { size?: number; className?: string }) {
  return <BadgeCheck size={size} strokeWidth={2.2} className={`inline-block shrink-0 text-brand ${className}`} aria-label="Verified on X" role="img" />;
}

/**
 * The name for a wallet: its username (and ✓) linking to the profile, or `fallback` (what the spot showed before
 * profiles: usually the short address linking to the explorer) when the wallet has none.
 */
export function WhoName({ address, fallback, className = "", tick = true, link = true, explorer }: { address: string; fallback?: ReactNode; className?: string; tick?: boolean; link?: boolean; explorer?: string }) {
  const n = useName(address);
  if (!n) return <>{fallback ?? <span className={`font-code ${className}`} title={address}>{shortAddr(address)}</span>}</>;
  const body = (
    <>
      <span className="truncate">{n.u}</span>
      {tick && n.v ? <VerifiedTick /> : null}
    </>
  );
  const cls = `inline-flex min-w-0 items-center gap-1 font-medium text-ink ${className}`;
  // inside a card that is already a link: plain text (a link in a link is invalid HTML)
  if (!link) return <span className={cls} title={`${n.d} · ${address}`}>{body}</span>;
  const name = <Link href={`/u/${n.u}`} className={`${cls} hover:underline underline-offset-2`} title={`${n.d} · ${address}`}>{body}</Link>;
  if (!explorer) return name;
  // where the address used to link to the block explorer, the name still does: the explorer is one small step away
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {name}
      <a href={explorer} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center text-muted transition-colors hover:text-ink motion-reduce:transition-none" aria-label={`${n.u} on the block explorer`} title={address}>
        <ArrowUpRight size={11} aria-hidden="true" />
      </a>
    </span>
  );
}

/** The profile picture when there is one, the wallet mark otherwise. */
export function WhoAvatar({ address, size = 28 }: { address: string; size?: number }) {
  const n = useName(address);
  if (n?.a) {
    // eslint-disable-next-line @next/next/no-img-element -- same-origin, already re-encoded to a 512px WebP
    return <img src={n.a} alt="" width={size} height={size} className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} loading="lazy" decoding="async" />;
  }
  return <WalletAvatar address={address} size={size} />;
}
