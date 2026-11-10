"use client";

import Image from "next/image";
import { ArrowRight, ArrowUpRight, Check, CircleAlert, Clock3, LoaderCircle, PauseCircle, Wallet } from "lucide-react";
import { useLocale, useTranslations } from "use-intl";
import { ToggleGroup, ToggleGroupItem } from "@/components/vendor/toggle-group";
import { CHAIN_LABELS, explorerAddress, explorerTx } from "@/lib/chainPublic";
import { fmtAmount, fmtFeePct, fmtRate } from "@/lib/earn/math";
import { depositPause, pausedCopy } from "@/lib/earn/terms";
import type { EarnVaultSnapshot } from "@/lib/earn/info";
import { explainEarn } from "./reasons";
import type { Earn, EarnTab } from "./useEarn";
import styles from "./EarnDialog.module.css";

/** Everything the panel shows, with no wallet behind it: the dialog passes the live hook, the review page fixtures. */
export type EarnView = Omit<Earn, "address">;

/** "182.8M": how much the vault holds, for scale. */
function compactAssets(raw: string, decimals: number): string {
  const n = Number(BigInt(raw) / 10n ** BigInt(decimals));
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** "Sep 14" (9月14日 in Chinese): a read's date for the rate's tooltip, in UTC like the chain. */
function day(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** The sheet's body: figures, Deposit/Withdraw, amount, vault facts, notices, the one action and the risk line. */
export default function EarnPanel({ view: e, snapshot, onConnect }: { view: EarnView; snapshot: EarnVaultSnapshot | null; onConnect: () => void }) {
  const t = useTranslations("earn");
  const locale = useLocale();
  // the reasons lib/earn and useEarn give in English, in the reader's language (components/earn/reasons.ts)
  const explain = (reason: string) => explainEarn(reason, (key, values) => t(`reasons.${key}`, values));
  const v = e.vault;
  const network = CHAIN_LABELS[v.chain];
  const sym = v.assetSymbol;
  const amt = (raw: bigint) => fmtAmount(raw, v.assetDecimals);
  const deposit = e.tab === "deposit";
  const pauseReason = depositPause(e.liveTerms, snapshot?.terms ?? null);
  const everything = !deposit && (e.all || (e.amount !== null && e.position !== undefined && e.position > 0n && e.amount >= e.position));
  const vaultFee = snapshot ? snapshot.performanceFeePct : 0;

  if (e.phase.k === "unconfirmed") {
    const p = e.phase;
    return (
      <div>
        <div className={styles.done} role="status">
          <span className={`${styles.doneIcon} ${styles.waitIcon}`}><Clock3 size={26} aria-hidden /></span>
          <h3>{t("unconfirmed.title")}</h3>
          <p>{p.tab === "deposit" ? t("unconfirmed.deposit", { amount: amt(p.amount), symbol: sym }) : t("unconfirmed.withdraw", { amount: amt(p.amount), symbol: sym })}</p>
        </div>
        <div className={styles.actions}>
          {p.sent.kind === "tx" ? <a className={styles.externalAction} href={explorerTx(v.chain, p.sent.hash)} target="_blank" rel="noreferrer">{t("viewTx")}<ArrowUpRight size={17} aria-hidden /></a> : <p className={styles.notice}>{t("unconfirmed.batch")}</p>}
          {p.note ? <p className={styles.notice} role="status">{explain(p.note)}</p> : null}
          <button type="button" className={styles.primary} onClick={() => void e.recheck()} disabled={p.checking}>
            {p.checking ? <LoaderCircle size={17} className={styles.spinner} aria-hidden /> : null}
            {p.checking ? t("unconfirmed.checking") : t("unconfirmed.checkAgain")}
          </button>
        </div>
        <p className={styles.disclaimer}>{t("unconfirmed.keep")}</p>
      </div>
    );
  }

  if (e.phase.k === "done") {
    const p = e.phase;
    return (
      <div>
        <div className={styles.done} role="status">
          <span className={styles.doneIcon}><Check size={26} aria-hidden /></span>
          <h3>{p.tab === "deposit" ? t("done.deposited", { amount: amt(p.amount), symbol: sym }) : t("done.withdrew", { amount: amt(p.amount), symbol: sym })}</h3>
          <p>{p.tab === "deposit" ? t("done.depositedBody", { symbol: sym, vault: v.name, chain: network }) : t("done.withdrewBody", { symbol: sym, chain: network })}</p>
        </div>
        {p.hash ? <a className={styles.externalAction} href={explorerTx(v.chain, p.hash)} target="_blank" rel="noreferrer">{t("viewTx")}<ArrowUpRight size={17} aria-hidden /></a> : null}
        <button type="button" className={styles.secondary} onClick={e.reset}>{t("done.close")}</button>
      </div>
    );
  }

  // a send in flight shows its progress even if the wallet changed network meanwhile: no switch offer until it settles
  const label = !e.isConnected ? t("action.connect")
    : e.phase.k === "preparing" ? t("action.preparing")
    : e.phase.k === "approving" ? t("action.approving", { amount: e.amount !== null ? amt(e.amount) : "", symbol: sym })
    : e.phase.k === "signing" ? t("action.signing")
    : e.phase.k === "sent" ? t("action.sent", { chain: network })
    : !e.onChain ? (e.switching ? t("action.switching") : t("action.switch", { chain: network }))
    : deposit && pauseReason ? t("action.paused")
    : e.problem ? explain(e.problem)
    : deposit ? (e.needsApproval ? t("action.allowAndDeposit", { amount: amt(e.amount!), symbol: sym }) : t("action.deposit", { amount: amt(e.amount!), symbol: sym }))
    : everything ? t("action.withdrawAll") : t("action.withdraw", { amount: amt(e.amount!), symbol: sym });
  const ready = e.isConnected && e.onChain && !e.busy && !e.problem && !(deposit && pauseReason);
  const clickable = !e.isConnected || (!e.onChain && !e.switching && !e.busy) || ready;
  const onClick = !e.isConnected ? onConnect : !e.onChain ? e.switchToVaultChain : e.submit;

  return (
    <form onSubmit={(event) => { event.preventDefault(); if (clickable) void onClick(); }}>
      <div className={styles.figures}>
        <div title={snapshot?.rateFrom ? t("rateTitle", { from: day(snapshot.rateFrom, locale), to: day(snapshot.rateTo, locale) }) : undefined}>
          <span className={styles.figureLabel}>{t("rate")}</span>
          <span className={styles.figureValue}>{fmtRate(snapshot?.rate ?? null)}</span>
          <span className={styles.figureHint}>{snapshot?.rate != null ? t("rateHint") : t("rateUnavailable")}</span>
        </div>
        <div>
          <span className={styles.figureLabel}>{t("yourDeposit")}</span>
          <span className={styles.figureValue}>{!e.isConnected ? "—" : e.position === undefined ? "…" : e.position === 0n ? t("none") : amt(e.position)}{e.isConnected && e.position !== undefined && e.position > 0n ? <small>{sym}</small> : null}</span>
          <span className={styles.figureHint}>{e.position !== undefined && e.position > 0n ? t("depositHint") : t("form.nothingIn", { vault: v.name })}</span>
        </div>
      </div>

      <ToggleGroup aria-label={t("form.tabs")} value={[e.tab]} onValueChange={(tabs) => { if (tabs[0] && !e.busy) e.setTab(tabs[0] as EarnTab); }} className={`${styles.tabs} grid w-full grid-cols-2`}>
        {(["deposit", "withdraw"] as EarnTab[]).map((tab) => <ToggleGroupItem key={tab} value={tab} disabled={e.busy} className="min-h-10 text-sm font-semibold">{tab === "deposit" ? t("deposit") : t("withdraw")}</ToggleGroupItem>)}
      </ToggleGroup>

      <div className={styles.amountSection}>
        <label htmlFor="earn-amount" className={styles.smallLabel}>{deposit ? t("form.youDeposit") : t("form.youWithdraw")}</label>
        <div className={styles.amountRow}>
          <input id="earn-amount" name="earn-amount" inputMode="decimal" autoComplete="off" spellCheck={false} placeholder="0.00" maxLength={32} value={e.text} onChange={(event) => e.setAmount(event.target.value)} disabled={e.busy} aria-describedby="earn-balance earn-risk" />
          <span className={styles.currency}><Image src="/brand/usdc.svg" alt="" width={26} height={26} draggable={false} aria-hidden />{sym}</span>
        </div>
        <div id="earn-balance" className={styles.balanceRow}>
          <span>{!e.isConnected ? t("form.onChain", { symbol: sym, chain: network }) : deposit ? (e.balance === undefined ? t("form.readingBalance") : t("form.inWallet", { amount: amt(e.balance), symbol: sym })) : (e.position === undefined ? t("form.readingDeposit") : t("form.deposited", { amount: amt(e.position), symbol: sym }))}</span>
          {e.isConnected ? <button type="button" className={styles.max} onClick={e.setMax} disabled={e.busy || (deposit ? !e.balance : !e.position)}>{t("form.max")}</button> : null}
        </div>
      </div>

      <dl className={styles.facts}>
        <div><dt>{t("facts.vault")}</dt><dd><a href={explorerAddress(v.chain, v.address)} target="_blank" rel="noreferrer">{v.name}<ArrowUpRight size={11} aria-hidden /></a></dd></div>
        <div><dt>{t("facts.runBy")}</dt><dd><a href={v.curatorUrl} target="_blank" rel="noreferrer">{v.curator}<ArrowUpRight size={11} aria-hidden /></a></dd></div>
        <div><dt>{t("facts.protocol")}</dt><dd><a href={v.protocolUrl} target="_blank" rel="noreferrer">{v.protocol}<ArrowUpRight size={11} aria-hidden /></a></dd></div>
        <div><dt>{t("facts.vaultFee")}</dt><dd>{t("facts.vaultFeeValue", { fee: fmtFeePct(vaultFee) })}</dd></div>
        <div><dt>{t("facts.openlaunchFee")}</dt><dd>{t("none")}</dd></div>
        <div><dt>{t("facts.inVault")}</dt><dd>{snapshot ? `${compactAssets(snapshot.totalAssets, v.assetDecimals)} ${sym}` : "—"}</dd></div>
        <div><dt>{t("facts.network")}</dt><dd>{t("facts.networkValue", { chain: network })}</dd></div>
      </dl>

      {deposit && pauseReason ? <p className={styles.paused} role="status"><PauseCircle size={16} aria-hidden /><span>{explain(pausedCopy(pauseReason))}</span></p> : null}
      {deposit && !pauseReason && e.needsApproval && !e.busy && e.isConnected ? <p className={styles.notice}>{t("notice.approval")}</p> : null}
      {everything && !e.busy ? <p className={styles.notice}>{t("notice.everything")}</p> : null}
      {e.isConnected && e.noGas ? <p className={styles.notice}>{t("notice.noGas", { chain: network })}</p> : null}
      {e.unreadable ? <p className={styles.notice}>{t("notice.unreadable")}</p> : null}
      {e.phase.k === "error" ? <p className={styles.error} role="alert"><CircleAlert size={16} aria-hidden /><span>{explain(e.phase.message)}</span></p> : null}

      <button type="submit" className={styles.primary} disabled={!clickable}>
        {e.busy || e.switching ? <LoaderCircle size={17} className={styles.spinner} aria-hidden /> : !e.isConnected ? <Wallet size={17} aria-hidden /> : null}
        {label}
        {ready ? <ArrowRight size={17} aria-hidden /> : null}
      </button>
      <p id="earn-risk" className={styles.disclaimer}>{t("disclaimer", { symbol: sym, protocol: v.protocol, curator: v.curator })}</p>
    </form>
  );
}
