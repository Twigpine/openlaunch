"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Landmark } from "lucide-react";
import type { Address } from "viem";
import { useTranslations } from "use-intl";
import { btn } from "@/components/ui";
import { CHAIN_LABELS } from "@/lib/chainPublic";
import { fmtAmount, fmtRate } from "@/lib/earn/math";
import type { EarnVaultSnapshot } from "@/lib/earn/info";
import { EARN_VAULTS, type EarnVault } from "@/lib/earn/vaults";
import { useEarnInfo } from "./earnInfo";
import useEarn, { type EarnTab } from "./useEarn";

const EarnDialog = dynamic(() => import("./EarnDialog"), { ssr: false });

/**
 * /me: put the wallet's idle USDC into the reviewed lending vault and take it out again. Renders nothing unless the
 * EARN switch is on (GET /api/earn). The dialog loads on first use.
 */
export default function EarnCard({ address }: { address: Address }) {
  const info = useEarnInfo();
  // the server names the vault it read; only an entry naming the vault this build lists for that chain is used
  const entry = info?.enabled ? info.vaults.find((x) => EARN_VAULTS[x.chain]?.address.toLowerCase() === x.address.toLowerCase()) : undefined;
  const vault = entry ? EARN_VAULTS[entry.chain] : null;
  if (!entry || !vault) return null;
  // keyed by wallet: another account starts from a clean form, with its own balances
  return <EarnCardLive key={address.toLowerCase()} vault={vault} snapshot={entry.snapshot} />;
}

/** The card for one wallet: owns the Earn state, so the sheet can close and reopen without losing a transaction. */
function EarnCardLive({ vault, snapshot }: { vault: EarnVault; snapshot: EarnVaultSnapshot | null }) {
  const earn = useEarn(vault, "deposit");
  // the dialog mounts on first open and stays mounted, like the bridge panel
  const [activated, setActivated] = useState(false);
  const [open, setOpen] = useState(false);
  const section = useRef<HTMLElement>(null);
  // /me#earn (the ⌘K entry): the card arrives after the page, so the browser's own jump to the anchor missed it
  useEffect(() => {
    if (window.location.hash === "#earn") section.current?.scrollIntoView({ block: "center" });
  }, []);
  /** Opens the sheet on the tab of the button pressed. */
  function show(tab: EarnTab) {
    // a transaction in flight keeps its tab and progress; otherwise open on the button pressed, with a clean form
    if (!earn.busy) {
      earn.reset();
      earn.setTab(tab);
    }
    setActivated(true);
    setOpen(true);
  }
  return (
    <>
      <EarnCardView ref={section} vault={vault} snapshot={snapshot} balance={earn.balance} position={earn.position} onOpen={show} />
      {activated ? <EarnDialog open={open} onOpenChange={setOpen} earn={earn} snapshot={snapshot} /> : null}
    </>
  );
}

/** The card itself, with no wallet behind it (the review page renders it with fixtures). */
export function EarnCardView({ ref, vault, snapshot, balance, position, onOpen }: { ref?: React.Ref<HTMLElement>; vault: EarnVault; snapshot: EarnVaultSnapshot | null; balance: bigint | undefined; position: bigint | undefined; onOpen: (tab: EarnTab) => void }) {
  const t = useTranslations("earn");
  const sym = vault.assetSymbol;
  const amt = (raw: bigint | undefined) => (raw === undefined ? "…" : fmtAmount(raw, vault.assetDecimals));
  const cell = (label: string, value: string, hint: string) => (
    <div className="min-w-0 rounded-xl border border-line bg-paper px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 truncate font-mono text-xl font-bold text-ink tnum">{value}</p>
      <p className="mt-1 truncate text-[11px] text-muted">{hint}</p>
    </div>
  );
  return (
    <section ref={ref} id="earn" aria-labelledby="earn-card" className="mb-4 scroll-mt-24 rounded-2xl border border-line bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="earn-card" className="inline-flex items-center gap-2 text-sm font-semibold text-ink"><Landmark size={15} className="text-brand" aria-hidden="true" />{t("card.title", { symbol: sym })}</h2>
        <p className="text-xs text-muted">{CHAIN_LABELS[vault.chain]} · {vault.name}</p>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {cell(t("rate"), fmtRate(snapshot?.rate ?? null), snapshot?.rate != null ? t("rateHint") : t("rateUnavailable"))}
        {cell(t("card.inWallet", { symbol: sym }), amt(balance), t("card.onChain", { chain: CHAIN_LABELS[vault.chain] }))}
        {cell(t("yourDeposit"), position === 0n ? t("none") : amt(position), position !== undefined && position > 0n ? t("depositHint") : t("card.nothingYet"))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className={btn.primarySm} onClick={() => onOpen("deposit")} aria-haspopup="dialog"><ArrowDownToLine size={14} aria-hidden="true" />{t("deposit")}</button>
        <button type="button" className={btn.secondarySm} onClick={() => onOpen("withdraw")} disabled={!position} aria-haspopup="dialog"><ArrowUpFromLine size={14} aria-hidden="true" />{t("withdraw")}</button>
        <p className="ml-auto text-[11px] text-muted">{t("card.runBy", { curator: vault.curator, protocol: vault.protocol })}</p>
      </div>
    </section>
  );
}
