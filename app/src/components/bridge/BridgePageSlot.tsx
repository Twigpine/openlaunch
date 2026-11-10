"use client";

import { useCallback } from "react";
import type { BridgeLink } from "@/lib/bridge/link";
import { bridgeSlot } from "./bridge-slot";
import styles from "./Signal.module.css";

/** The /bridge page's place for the panel. The header's bridge controller renders into it (bridge-slot.ts). */
export default function BridgePageSlot({ link }: { link: BridgeLink | null }) {
  const attach = useCallback((node: HTMLDivElement | null) => (node ? bridgeSlot.mount(node, link) : undefined), [link]);
  return (
    <div ref={attach} className={styles.pageSlot}>
      <p className={styles.pageSlotWaiting}>Loading the bridge…</p>
    </div>
  );
}
