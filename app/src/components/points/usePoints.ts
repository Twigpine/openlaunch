"use client";

import { useEffect, useState } from "react";
import type { WalletPoints } from "@/lib/points/server";
import type { NotEligibleReason } from "@/lib/points/score";

export type PointsState = { season: { name: string; starts_at: string; ends_at: string; ended: boolean } | null; me: WalletPoints | null; reason: NotEligibleReason | null; at: number } | null;

/**
 * The public season and this wallet's points (null season while the season is not public). The answer is tagged with
 * the wallet it was read for: after a switch in the wallet app the previous wallet's standing is never returned (null
 * until the new one answers), and an answer that arrives after the switch is dropped.
 */
export function usePoints(wallet: string | undefined): PointsState {
  const me = wallet?.toLowerCase() ?? "";
  const [state, setState] = useState<{ wallet: string; v: NonNullable<PointsState> } | null>(null);
  useEffect(() => {
    let alive = true;
    const id = setTimeout(async () => {
      try {
        const r = await fetch(`/api/points${me ? `?wallet=${me}` : ""}`, { cache: "no-store" });
        if (!r.ok) return;
        const v = { ...((await r.json()) as Omit<NonNullable<PointsState>, "at">), at: Date.now() };
        if (alive) setState({ wallet: me, v }); // checked after the body is read, not before
      } catch {
        /* points are a side panel: say nothing on a blip */
      }
    }, 0);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [me]);
  return state && state.wallet === me ? state.v : null;
}
