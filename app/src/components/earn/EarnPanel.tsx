"use client";

import Image from "next/image";
import { ArrowRight, ArrowUpRight, Check, CircleAlert, Clock3, LoaderCircle, PauseCircle, Wallet } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/vendor/toggle-group";
import { CHAIN_LABELS, explorerAddress, explorerTx } from "@/lib/chainPublic";
import { fmtAmount, fmtFeePct, fmtRate } from "@/lib/earn/math";
import { depositPause, pausedCopy } from "@/lib/earn/terms";
import type { EarnVaultSnapshot } from "@/lib/earn/info";
import type { Earn, EarnTab } from "./useEarn";
import styles from "./EarnDialog.module.css";

/** Everything the panel shows, with no wallet behind it: the dialog passes the live hook, the review page fixtures. */
export type EarnView = Omit<Earn, "address">;

/** "182.8M": how much the vault holds, for scale. */
function compactAssets(raw: string, decimals: number): string {
  const n = Number(BigInt(raw) / 10n ** BigInt(decimals));
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** "Sep 14": a read's date for the rate's tooltip, in UTC like the chain. */
function day(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** The sheet's body: figures, Deposit/Withdraw, amount, vault facts, notices, the one action and the risk line. */
export default function EarnPanel({ view: e, snapshot, onConnect }: { view: EarnView; snapshot: EarnVaultSnapshot | null; onConnect: () => void }) {
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
    const what = p.tab === "deposit" ? "deposit" : "withdrawal";
    return (
      <div>
        <div className={styles.done} role="status">
          <span className={`${styles.doneIcon} ${styles.waitIcon}`}><Clock3 size={26} aria-hidden /></span>
          <h3>Sent, not confirmed yet</h3>
          <p>Your wallet sent the {what} of {amt(p.amount)} {sym}, but its confirmation could not be read. It may still go through. Do not send it again until this is settled.</p>
        </div>
        <div className={styles.actions}>
          {p.sent.kind === "tx" ? <a className={styles.externalAction} href={explorerTx(v.chain, p.sent.hash)} target="_blank" rel="noreferrer">View the transaction<ArrowUpRight size={17} aria-hidden /></a> : <p className={styles.notice}>It was sent as one batch from your wallet; your wallet’s activity shows whether it went through.</p>}
          {p.note ? <p className={styles.notice} role="status">{p.note}</p> : null}
          <button type="button" className={styles.primary} onClick={() => void e.recheck()} disabled={p.checking}>
            {p.checking ? <LoaderCircle size={17} className={styles.spinner} aria-hidden /> : null}
            {p.checking ? "Checking…" : "Check again"}
          </button>
        </div>
        <p className={styles.disclaimer}>Closing this sheet keeps the check. Reloading the page forgets it, so look at your wallet’s activity before sending again.</p>
      </div>
    );
  }

  if (e.phase.k === "done") {
    const p = e.phase;
    return (
      <div>
        <div className={styles.done} role="status">
          <span className={styles.doneIcon}><Check size={26} aria-hidden /></span>
          <h3>{p.tab === "deposit" ? `Deposited ${amt(p.amount)} ${sym}` : `Withdrew ${amt(p.amount)} ${sym}`}</h3>
          <p>{p.tab === "deposit" ? `Your ${sym} is in ${v.name} on ${network}. Its value updates as the vault earns.` : `The ${sym} is back in your wallet on ${network}.`}</p>
        </div>
        {p.hash ? <a className={styles.externalAction} href={explorerTx(v.chain, p.hash)} target="_blank" rel="noreferrer">View the transaction<ArrowUpRight size={17} aria-hidden /></a> : null}
        <button type="button" className={styles.secondary} onClick={e.reset}>Done</button>
      </div>
    );
  }

  // a send in flight shows its progress even if the wallet changed network meanwhile: no switch offer until it settles
  const label = !e.isConnected ? "Connect wallet"
    : e.phase.k === "preparing" ? "Checking the vault…"
    : e.phase.k === "approving" ? `Allow exactly ${e.amount !== null ? amt(e.amount) : ""} ${sym} in your wallet…`
    : e.phase.k === "signing" ? "Confirm in your wallet…"
    : e.phase.k === "sent" ? `Confirming on ${network}…`
    : !e.onChain ? (e.switching ? "Confirm the network switch…" : `Switch to ${network}`)
    : deposit && pauseReason ? "Deposits paused"
    : e.problem ? e.problem
    : deposit ? (e.needsApproval ? `Allow and deposit ${amt(e.amount!)} ${sym}` : `Deposit ${amt(e.amount!)} ${sym}`)
    : everything ? "Withdraw everything" : `Withdraw ${amt(e.amount!)} ${sym}`;
  const ready = e.isConnected && e.onChain && !e.busy && !e.problem && !(deposit && pauseReason);
  const clickable = !e.isConnected || (!e.onChain && !e.switching && !e.busy) || ready;
  const onClick = !e.isConnected ? onConnect : !e.onChain ? e.switchToVaultChain : e.submit;

  return (
    <form onSubmit={(event) => { event.preventDefault(); if (clickable) void onClick(); }}>
      <div className={styles.figures}>
        <div title={snapshot?.rateFrom ? `Share price growth from ${day(snapshot.rateFrom)} to ${day(snapshot.rateTo)}, net of the vault's fees` : undefined}>
          <span className={styles.figureLabel}>Last 30 days</span>
          <span className={styles.figureValue}>{fmtRate(snapshot?.rate ?? null)}</span>
          <span className={styles.figureHint}>{snapshot?.rate != null ? "Annualised. Variable." : "Rate unavailable right now"}</span>
        </div>
        <div>
          <span className={styles.figureLabel}>Your deposit</span>
          <span className={styles.figureValue}>{!e.isConnected ? "—" : e.position === undefined ? "…" : e.position === 0n ? "None" : amt(e.position)}{e.isConnected && e.position !== undefined && e.position > 0n ? <small>{sym}</small> : null}</span>
          <span className={styles.figureHint}>{e.position !== undefined && e.position > 0n ? "What it withdraws for now" : `Nothing in ${v.name}`}</span>
        </div>
      </div>

      <ToggleGroup aria-label="Deposit or withdraw" value={[e.tab]} onValueChange={(t) => { if (t[0] && !e.busy) e.setTab(t[0] as EarnTab); }} className={`${styles.tabs} grid w-full grid-cols-2`}>
        {(["deposit", "withdraw"] as EarnTab[]).map((t) => <ToggleGroupItem key={t} value={t} disabled={e.busy} className="min-h-10 text-sm font-semibold">{t === "deposit" ? "Deposit" : "Withdraw"}</ToggleGroupItem>)}
      </ToggleGroup>

      <div className={styles.amountSection}>
        <label htmlFor="earn-amount" className={styles.smallLabel}>{deposit ? "You deposit" : "You withdraw"}</label>
        <div className={styles.amountRow}>
          <input id="earn-amount" name="earn-amount" inputMode="decimal" autoComplete="off" spellCheck={false} placeholder="0.00" maxLength={32} value={e.text} onChange={(event) => e.setAmount(event.target.value)} disabled={e.busy} aria-describedby="earn-balance earn-risk" />
          <span className={styles.currency}><Image src="/brand/usdc.svg" alt="" width={26} height={26} draggable={false} aria-hidden />{sym}</span>
        </div>
        <div id="earn-balance" className={styles.balanceRow}>
          <span>{!e.isConnected ? `${sym} on ${network}` : deposit ? (e.balance === undefined ? "Reading your balance…" : `In your wallet: ${amt(e.balance)} ${sym}`) : (e.position === undefined ? "Reading your deposit…" : `Deposited: ${amt(e.position)} ${sym}`)}</span>
          {e.isConnected ? <button type="button" className={styles.max} onClick={e.setMax} disabled={e.busy || (deposit ? !e.balance : !e.position)}>Max</button> : null}
        </div>
      </div>

      <dl className={styles.facts}>
        <div><dt>Vault</dt><dd><a href={explorerAddress(v.chain, v.address)} target="_blank" rel="noreferrer">{v.name}<ArrowUpRight size={11} aria-hidden /></a></dd></div>
        <div><dt>Run by</dt><dd><a href={v.curatorUrl} target="_blank" rel="noreferrer">{v.curator}<ArrowUpRight size={11} aria-hidden /></a></dd></div>
        <div><dt>Protocol</dt><dd><a href={v.protocolUrl} target="_blank" rel="noreferrer">{v.protocol}<ArrowUpRight size={11} aria-hidden /></a></dd></div>
        <div><dt>Vault fee</dt><dd>{fmtFeePct(vaultFee)} of interest</dd></div>
        <div><dt>openlaunch fee</dt><dd>None</dd></div>
        <div><dt>In the vault</dt><dd>{snapshot ? `${compactAssets(snapshot.totalAssets, v.assetDecimals)} ${sym}` : "—"}</dd></div>
        <div><dt>Network</dt><dd>{network} · gas in ETH</dd></div>
      </dl>

      {deposit && pauseReason ? <p className={styles.paused} role="status"><PauseCircle size={16} aria-hidden /><span>{pausedCopy(pauseReason)}</span></p> : null}
      {deposit && !pauseReason && e.needsApproval && !e.busy && e.isConnected ? <p className={styles.notice}>The first deposit asks your wallet twice: once to allow the vault exactly this amount, then to deposit it. Smart wallets do both in one step.</p> : null}
      {everything && !e.busy ? <p className={styles.notice}>Withdraws your whole deposit, with the interest earned up to the moment it confirms.</p> : null}
      {e.isConnected && e.noGas ? <p className={styles.notice}>This wallet has no ETH on {network} to pay network gas.</p> : null}
      {e.unreadable ? <p className={styles.notice}>Your balances could not be read just now. They refresh on their own.</p> : null}
      {e.phase.k === "error" ? <p className={styles.error} role="alert"><CircleAlert size={16} aria-hidden /><span>{e.phase.message}</span></p> : null}

      <button type="submit" className={styles.primary} disabled={!clickable}>
        {e.busy || e.switching ? <LoaderCircle size={17} className={styles.spinner} aria-hidden /> : !e.isConnected ? <Wallet size={17} aria-hidden /> : null}
        {label}
        {ready ? <ArrowRight size={17} aria-hidden /> : null}
      </button>
      <p id="earn-risk" className={styles.disclaimer}>
        Deposits can lose money. Your {sym} is lent to borrowers through {v.protocol}, in markets chosen by {v.curator}, not by openlaunch. openlaunch never holds your funds, cannot move them and cannot guarantee a withdrawal: the vault pays out from what is not lent at that moment. The rate changes all the time; past rates promise nothing.
      </p>
    </form>
  );
}
