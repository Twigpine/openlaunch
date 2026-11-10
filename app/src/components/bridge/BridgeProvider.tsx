"use client";

import dynamic from "next/dynamic";
import { createContext, useCallback, useContext, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeftRight } from "lucide-react";
import { bridgeSlot } from "./bridge-slot";
import styles from "./BridgeDialog.module.css";

const BridgeDialog = dynamic(() => import("./BridgeDialog"), { ssr: false });
const BridgeContext = createContext<(() => void) | null>(null);

/** Mounted once for both navigation variants and for the /bridge page; closing the panel does not stop tracking. */
export function BridgeProvider({ children }: { children: React.ReactNode }) {
  const [activated, setActivated] = useState(false);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  // the /bridge page's slot: while it exists the panel lives in the page, and the dialog stays shut
  const slot = useSyncExternalStore(bridgeSlot.subscribe, bridgeSlot.getSnapshot, bridgeSlot.getServerSnapshot);
  if (slot.node && open) setOpen(false);
  const show = useCallback(() => {
    const page = bridgeSlot.getSnapshot().node;
    if (page) {
      page.scrollIntoView({ block: "nearest" });
      page.querySelector<HTMLElement>("#bridge-amount")?.focus({ preventScroll: true });
      return;
    }
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setActivated(true);
    setOpen(true);
  }, []);
  const restoreFocus = useCallback(() => trigger.current?.isConnected
    ? trigger.current
    : document.querySelector<HTMLButtonElement>('[aria-controls="mobile-menu"]'), []);

  return (
    <BridgeContext.Provider value={show}>
      {children}
      {activated || slot.node ? <BridgeDialog open={open} onOpenChange={setOpen} restoreFocus={restoreFocus} slot={slot.node} link={slot.link} /> : null}
    </BridgeContext.Provider>
  );
}

/** Opens the bridge panel from anywhere inside the provider (the ⌘K search uses it). Null outside it. */
export function useOpenBridge(): (() => void) | null {
  return useContext(BridgeContext);
}

/** `compact` drops the label (icon only) where the header has no room: the whole desktop strip, resting or floating. */
export function BridgeButton({ block = false, compact = false, onOpen }: { block?: boolean; compact?: boolean; onOpen?: () => void }) {
  const show = useContext(BridgeContext);
  return (
    <button type="button" className={`${styles.trigger} ${block ? styles.blockTrigger : ""} ${compact && !block ? styles.compactTrigger : ""}`} aria-label="Bridge funds" aria-haspopup="dialog" title="Bridge to Base, Robinhood and Arc, or fund them from Ethereum, Arbitrum and Optimism" onClick={() => { show?.(); onOpen?.(); }}>
      <ArrowLeftRight size={17} strokeWidth={1.8} aria-hidden />
      <span className={styles.triggerLabel}>Bridge</span>
      {block ? <span className={styles.triggerHint}>Base · Robinhood · Arc</span> : null}
    </button>
  );
}
