"use client";

import dynamic from "next/dynamic";
import { createContext, useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeftRight } from "lucide-react";
import { bridgeSlot } from "./bridge-slot";
import type { BridgeLink } from "@/lib/bridge/link";
import styles from "./BridgeDialog.module.css";

const BridgeDialog = dynamic(() => import("./BridgeDialog"), { ssr: false });
type OpenBridge = (link?: BridgeLink) => void;
const BridgeContext = createContext<{ show: OpenBridge; wake: () => void } | null>(null);

/** Mounted once for both navigation variants and for the /bridge page; closing the panel does not stop tracking. */
export function BridgeProvider({ children }: { children: React.ReactNode }) {
  const [activated, setActivated] = useState(false);
  const [open, setOpen] = useState(false);
  // a route asked for by the caller (the token page's "bridge, then buy"); the count makes a repeat request apply again
  const [requested, setRequested] = useState<{ link: BridgeLink; count: number } | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  // the /bridge page's slot: while it exists the panel lives in the page, and the dialog stays shut
  const slot = useSyncExternalStore(bridgeSlot.subscribe, bridgeSlot.getSnapshot, bridgeSlot.getServerSnapshot);
  if (slot.node && open) setOpen(false);
  // the page's own route takes over; leaving the page must not bring back an older request
  if (slot.node && requested) setRequested(null);
  const show = useCallback((link?: BridgeLink) => {
    const page = bridgeSlot.getSnapshot().node;
    if (page) {
      page.scrollIntoView({ block: "nearest" });
      page.querySelector<HTMLElement>("#bridge-amount")?.focus({ preventScroll: true });
      return;
    }
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (link) setRequested((prior) => ({ link, count: (prior?.count ?? 0) + 1 }));
    setActivated(true);
    setOpen(true);
  }, []);
  // Mount the controller without opening anything, so a transfer saved in this browser keeps being tracked while the
  // buyer stays on a token page. Tracking never asks the wallet for anything.
  const wake = useCallback(() => setActivated(true), []);
  const value = useMemo(() => ({ show, wake }), [show, wake]);
  const restoreFocus = useCallback(() => trigger.current?.isConnected
    ? trigger.current
    : document.querySelector<HTMLButtonElement>('[aria-controls="mobile-menu"]'), []);

  return (
    <BridgeContext.Provider value={value}>
      {children}
      {activated || slot.node ? <BridgeDialog open={open} onOpenChange={setOpen} restoreFocus={restoreFocus} slot={slot.node} link={slot.node ? slot.link : requested?.link ?? null} linkCount={slot.node ? 0 : requested?.count ?? 0} /> : null}
    </BridgeContext.Provider>
  );
}

/**
 * Opens the bridge panel from anywhere inside the provider (the ⌘K search uses it), optionally on a route. The route
 * goes through the panel's guarded pickers, so it never changes a transfer or approval in progress. Null outside it.
 */
export function useOpenBridge(): OpenBridge | null {
  return useContext(BridgeContext)?.show ?? null;
}

/** Starts background tracking of a saved transfer without opening the panel. Null outside the provider. */
export function useWakeBridge(): (() => void) | null {
  return useContext(BridgeContext)?.wake ?? null;
}

/** `compact` drops the label (icon only) where the header has no room: the whole desktop strip, resting or floating. */
export function BridgeButton({ block = false, compact = false, onOpen }: { block?: boolean; compact?: boolean; onOpen?: () => void }) {
  const show = useContext(BridgeContext)?.show;
  return (
    <button type="button" className={`${styles.trigger} ${block ? styles.blockTrigger : ""} ${compact && !block ? styles.compactTrigger : ""}`} aria-label="Bridge funds" aria-haspopup="dialog" title="Bridge to Base, Robinhood and Arc, or fund them from Ethereum, Arbitrum and Optimism" onClick={() => { show?.(); onOpen?.(); }}>
      <ArrowLeftRight size={17} strokeWidth={1.8} aria-hidden />
      <span className={styles.triggerLabel}>Bridge</span>
      {block ? <span className={styles.triggerHint}>Base · Robinhood · Arc</span> : null}
    </button>
  );
}
