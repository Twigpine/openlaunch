"use client";

import { startTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import { REFRESH_MS } from "./usePoints";

/**
 * Re-renders the server-rendered boards every few minutes while the page is visible (and on coming back to it), at
 * the same pace as your own standing (usePoints), so a page left open across an hourly run never shows a new rank of
 * yours beside an old board. Client state (your standing, the tabs) is kept.
 */
export default function BoardRefresh() {
  const router = useRouter();
  useEffect(() => {
    let last = Date.now();
    const tick = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < REFRESH_MS) return;
      last = Date.now();
      startTransition(() => router.refresh());
    };
    const id = window.setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router]);
  return null;
}
