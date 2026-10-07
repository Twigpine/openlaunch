"use client";

import { useEffect, useState } from "react";
import type { WalletPoints } from "@/lib/points/server";

export type PointsState = { season: { name: string; starts_at: string; ends_at: string } | null; me: WalletPoints | null; at: number } | null;

/** The public season and this wallet's points (null season while the season is not public). */
export function usePoints(wallet: string | undefined): PointsState {
  const [state, setState] = useState<PointsState>(null);
  useEffect(() => {
    let alive = true;
    const id = setTimeout(async () => {
      try {
        const r = await fetch(`/api/points${wallet ? `?wallet=${wallet}` : ""}`, { cache: "no-store" });
        if (r.ok && alive) setState({ ...((await r.json()) as Omit<NonNullable<PointsState>, "at">), at: Date.now() });
      } catch {
        /* points are a side panel: say nothing on a blip */
      }
    }, 0);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [wallet]);
  return state;
}
