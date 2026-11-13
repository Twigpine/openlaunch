"use client";

import { useEffect, useState } from "react";
import type { EarnInfo } from "@/lib/earn/info";

/** The request in flight, shared by every caller that asks before it settles. */
let pending: Promise<EarnInfo> | null = null;

/**
 * GET /api/earn, shared while in flight (the /me card and the ⌘K list asking at once make one request). A settled
 * answer is not remembered: every later caller reads the switch as it is now, so turning EARN off takes effect on the
 * next /me visit or ⌘K open, without a reload. A failed request reads as "off".
 */
export function loadEarnInfo(): Promise<EarnInfo> {
  pending ??= fetch("/api/earn", { cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<EarnInfo>) : Promise.reject(new Error(String(r.status)))))
    .catch((): EarnInfo => ({ enabled: false }))
    .finally(() => {
      pending = null;
    });
  return pending;
}

/**
 * The answer, or null until it arrives; asked again on each mount or (re)activation. `active` false skips it (the ⌘K
 * list asks when opened). Deactivating forgets the answer, so a reopened list shows nothing from the last open (say,
 * an Earn entry since switched off) until the fresh answer lands.
 */
export function useEarnInfo(active = true): EarnInfo | null {
  const [info, setInfo] = useState<EarnInfo | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    void loadEarnInfo().then((i) => {
      if (alive) setInfo(i);
    });
    return () => {
      alive = false;
      setInfo(null);
    };
  }, [active]);
  return active ? info : null;
}
