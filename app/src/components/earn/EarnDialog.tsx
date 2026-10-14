"use client";

import { useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { ArrowUpRight, X } from "lucide-react";
import type { EarnVaultSnapshot } from "@/lib/earn/info";
import type { EarnVault } from "@/lib/earn/vaults";
import WalletPicker from "../WalletPicker";
import EarnPanel, { type EarnView } from "./EarnPanel";
import styles from "./EarnDialog.module.css";

/**
 * The Earn sheet, lazy-loaded by the /me card on first open. The state lives in the card (useEarn), so closing the sheet
 * mid-transaction loses nothing: the transaction still confirms, the toast still fires, reopening shows where it is.
 */
export default function EarnDialog({ open, onOpenChange, earn, snapshot }: { open: boolean; onOpenChange: (open: boolean) => void; earn: EarnView; snapshot: EarnVaultSnapshot | null }) {
  const popup = useRef<HTMLDivElement>(null);
  const [connecting, setConnecting] = useState(false);
  const v = earn.vault;
  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Backdrop className={styles.backdrop} />
          <Dialog.Popup ref={popup} initialFocus={popup} finalFocus={connecting ? false : undefined} className={styles.panel}>
            <EarnShell vault={v}
              title={<Dialog.Title className={styles.title}>Earn on {v.assetSymbol}</Dialog.Title>}
              close={<Dialog.Close className={styles.close} aria-label="Close"><X size={19} aria-hidden /></Dialog.Close>}
              description={<Dialog.Description className={styles.description}>Lend your {v.assetSymbol} through a {v.protocol} vault on Base. Take it out whenever the vault has it free.</Dialog.Description>}>
              <EarnPanel view={earn} snapshot={snapshot} onConnect={() => { onOpenChange(false); setConnecting(true); }} />
            </EarnShell>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      {connecting ? <WalletPicker onClose={() => { setConnecting(false); onOpenChange(true); }} /> : null}
    </>
  );
}

/** Heading, body and footer of the sheet; the review page renders it without a dialog around it. */
export function EarnShell({ vault, title, description, close, children }: { vault: EarnVault; title: React.ReactNode; description: React.ReactNode; close: React.ReactNode; children: React.ReactNode }) {
  return (
    <>
      <div className={styles.heading}>{title}{close}</div>
      {description}
      {children}
      <div className={styles.footer}>
        <a href={vault.curatorUrl} target="_blank" rel="noreferrer">Run by {vault.curator}<ArrowUpRight size={12} aria-hidden /></a>
        <span>0 openlaunch fee</span>
      </div>
    </>
  );
}
