"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useConfig } from "wagmi";
import { useHydratedAccount } from "@/lib/useHydratedAccount";
import { getWalletClient } from "wagmi/actions";
import { btn, card } from "@/components/ui";
import { buildModMessage } from "@/lib/launchpad/posts";
import type { PostRow } from "@/lib/launchpad/postsServer";
import { CHAINS, shortAddr } from "@/lib/chainPublic";
import { nowMs } from "@/lib/launchpad/time";
import { friendlyError } from "@/lib/errors";

function nonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Moderation queue: reported posts, hide/unhide with an admin-wallet signature. */
export default function AdminQueue() {
  const { address } = useHydratedAccount();
  const config = useConfig();
  const [posts, setPosts] = useState<PostRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!address) return;
    const res = await fetch(`/api/posts/reported?wallet=${address}`, { cache: "no-store" });
    const d = (await res.json()) as { posts?: PostRow[]; error?: string };
    if (!res.ok) {
      setErr(d.error ?? "not allowed");
      setPosts(null);
      return;
    }
    setErr(null);
    setPosts(d.posts ?? []);
  }, [address]);
  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  async function act(p: PostRow, action: "hide" | "unhide") {
    if (!address) return;
    try {
      const n = nonce();
      const ts = nowMs();
      const target = `post:${p.id}`;
      const wallet = await getWalletClient(config, { chainId: CHAINS[p.chain].id });
      const signature = await wallet.signMessage({ message: buildModMessage({ action, target, wallet: address, nonce: n, ts }) });
      const res = await fetch("/api/posts/mod", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, target, wallet: address, nonce: n, ts, signature }) });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "failed");
      await load();
    } catch (e) {
      setErr(friendlyError(e));
    }
  }

  if (!address) return <p className={`${card} p-6 text-sm text-muted`}>Connect the admin wallet.</p>;
  if (err) return <p className={`${card} p-6 text-sm text-down-ink`}>{err}</p>;
  return (
    <div className="space-y-2">
      {posts?.length === 0 ? <p className={`${card} p-6 text-sm text-muted`}>Nothing reported.</p> : null}
      {posts?.map((p) => (
        <div key={p.id} className={`${card} p-4 space-y-2`}>
          <div className="flex items-center gap-2 text-[11px] font-mono text-muted flex-wrap">
            <Link href={`/t/${p.chain}/${p.token}#comments`} className="text-ink font-sans font-semibold">{p.symbol}</Link>
            <span>{shortAddr(p.wallet)}</span>
            <span>#{p.id}</span>
            <span className="text-warm-ink">{p.reports} report{p.reports === 1 ? "" : "s"}</span>
            {p.hidden ? <span className="text-down-ink">hidden</span> : <span className="text-up">visible</span>}
          </div>
          <p className="text-sm text-ink whitespace-pre-wrap break-words">{p.body}</p>
          <div className="flex gap-2">
            {p.hidden ? (
              <button type="button" onClick={() => void act(p, "unhide")} className={btn.secondarySm}>Unhide</button>
            ) : (
              <button type="button" onClick={() => void act(p, "hide")} className={`${btn.secondarySm} text-down-ink`}>Hide</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
