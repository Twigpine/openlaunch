"use client";

import { useEffect, useState } from "react";
import type { WalletPoints } from "@/lib/points/server";
import { PUBLIC_REASONS, type PublicReason } from "@/lib/points/score";

export type PointsState = { season: { name: string; starts_at: string; ends_at: string; ended: boolean; final: boolean } | null; me: WalletPoints | null; reason: PublicReason | null; at: number } | null;

const REFRESH_MS = 5 * 60_000; // points are recomputed hourly; a page left open picks up a publish or a new run
const RETRY_MS = [10_000, 30_000, 60_000]; // after a failed read, then back to the normal refresh

/**
 * The public season and this wallet's points (null season while the season is not public). The answer is tagged with
 * the wallet it was read for: after a switch in the wallet app the previous wallet's standing is never returned (null
 * until the new one answers), and an answer that arrives after the switch is dropped. While the page stays open it
 * reads again every few minutes (skipped in hidden tabs), and a failed read is retried sooner.
 */
export function usePoints(wallet: string | undefined): PointsState {
  const me = wallet?.toLowerCase() ?? "";
  const [state, setState] = useState<{ wallet: string; v: NonNullable<PointsState> } | null>(null);
  useEffect(() => {
    let alive = true;
    let failures = 0;
    let id: ReturnType<typeof setTimeout>;
    const next = (ms: number) => {
      if (alive) id = setTimeout(() => void read(), ms);
    };
    const read = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return next(REFRESH_MS);
      try {
        const r = await fetch(`/api/points${me ? `?wallet=${me}` : ""}`, { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const d = (await r.json()) as Omit<NonNullable<PointsState>, "at">;
        // only a reason the card knows how to say is kept
        const v = { ...d, reason: PUBLIC_REASONS.includes(d.reason as PublicReason) ? d.reason : null, at: Date.now() };
        if (!alive) return; // checked after the body is read, not before
        setState({ wallet: me, v });
        failures = 0;
        next(REFRESH_MS);
      } catch {
        /* points are a side panel: say nothing on a blip, try again soon */
        next(RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]);
      }
    };
    id = setTimeout(() => void read(), 0);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [me]);
  return state && state.wallet === me ? state.v : null;
}
