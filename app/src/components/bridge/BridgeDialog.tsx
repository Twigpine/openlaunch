"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { Dialog } from "@base-ui/react/dialog";
import { Select } from "@base-ui/react/select";
import { useTranslations } from "use-intl";
import { ArrowLeftRight, ArrowRight, ArrowUpRight, Check, ChevronDown, ChevronRight, CircleAlert, Clock3, LoaderCircle, Wallet, X } from "lucide-react";
import { formatEther, formatUnits, zeroAddress } from "viem";
import { BRIDGE_ASSETS, BRIDGE_CHAINS, BRIDGE_CHAIN_IDS, bridgeCurrency, bridgeTransferInputCurrency, isBridgeAssetSupported, isBridgeChainId, type BridgeAsset, type BridgeChainId, type BridgeQuoteRejection } from "@/lib/bridge/types";
import { DISCARD_AFTER_MS } from "@/lib/bridge/client";
import { formatFeeWarningPercent } from "@/lib/bridge/fee-display";
import { shortAddr } from "@/lib/chainPublic";
import WalletPicker from "../WalletPicker";
import WalletAvatar from "../WalletAvatar";
import useBridge from "./useBridge";
import styles from "./BridgeDialog.module.css";

type Bridge = ReturnType<typeof useBridge>;
const networkItems = BRIDGE_CHAIN_IDS.map((id) => ({ value: id, label: BRIDGE_CHAINS[id].name }));

function nativeAmount(value: string | bigint): string {
  const text = typeof value === "bigint" ? formatEther(value) : value;
  const [whole, decimal = ""] = text.split(".");
  const cut = decimal.slice(0, 7).replace(/0+$/, "");
  return whole === "0" && !cut && /[1-9]/.test(decimal) ? "<0.0000001" : `${whole}${cut ? `.${cut}` : ""}`;
}

function NetworkMark({ chain }: { chain: BridgeChainId }) {
  return <span className={`${styles.networkMark} ${chain === 5042 ? styles.arcMark : ""}`} aria-hidden>{chain === 8453
    ? <Image src="/brand/base.svg" alt="" width={30} height={30} draggable={false} />
    : chain === 5042 ? <Image src="/brand/arc.svg" alt="" width={23} height={24} draggable={false} />
    : <>
      <Image className={styles.lightLogo} src="/brand/robinhood-black.svg" alt="" width={23} height={30} draggable={false} />
      <Image className={styles.darkLogo} src="/brand/robinhood-white.svg" alt="" width={23} height={30} draggable={false} />
    </>}</span>;
}

function AssetMark({ asset, size = 24 }: { asset: BridgeAsset; size?: number }) {
  return <Image src={asset === "USDC" ? "/brand/usdc.svg" : "/brand/ethereum.svg"} alt="" width={size} height={size} draggable={false} aria-hidden />;
}

function AssetSelect({ label, chain, asset, disabled, onChange }: { label: "Send" | "Receive"; chain: BridgeChainId; asset: BridgeAsset; disabled: boolean; onChange: (asset: BridgeAsset) => void }) {
  const t = useTranslations("bridge");
  const [instant, setInstant] = useState(false);
  const choices = BRIDGE_ASSETS[chain];
  const send = label === "Send";
  if (choices.length === 1) return <span className={styles.currency} aria-label={t(send ? "asset.sendOne" : "asset.receiveOne", { asset })}><AssetMark asset={asset} size={28} />{asset}</span>;
  return <Select.Root value={asset} items={choices.map((value) => ({ value, label: value }))} disabled={disabled}
    onValueChange={(value) => { if (isBridgeAssetSupported(chain, value)) onChange(value); }}
    onOpenChange={(_, details) => setInstant(details.event.type.startsWith("key"))}>
    <Select.Trigger type="button" aria-label={t(send ? "asset.send" : "asset.receive")} className={styles.assetTrigger}>
      <AssetMark asset={asset} size={28} /><Select.Value /><Select.Icon className={styles.networkChevron}><ChevronDown size={14} aria-hidden /></Select.Icon>
    </Select.Trigger>
    <Select.Portal>
      <Select.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={16} alignItemWithTrigger={false} className={styles.networkPositioner}>
        <Select.Popup className={styles.networkPopup} data-instant={instant || undefined}>
          <p className={styles.networkMenuTitle}>{t(send ? "asset.sendOn" : "asset.receiveOn", { network: BRIDGE_CHAINS[chain].name })}</p>
          <Select.List className={styles.networkList}>
            {choices.map((value) => <Select.Item key={value} value={value} label={value} className={styles.networkOption}>
              <AssetMark asset={value} size={30} />
              <span className={styles.networkCopy}><Select.ItemText className={styles.networkName}>{value}</Select.ItemText><span className={styles.gasCurrency}>{t(value === "ETH" ? "asset.eth" : "asset.usdc")}</span></span>
              <Select.ItemIndicator className={styles.networkCheck}><Check size={17} strokeWidth={2.5} aria-hidden /></Select.ItemIndicator>
            </Select.Item>)}
          </Select.List>
        </Select.Popup>
      </Select.Positioner>
    </Select.Portal>
  </Select.Root>;
}

function NetworkSelect({ label, chain, disabled, onChange }: { label: "From" | "To"; chain: BridgeChainId; disabled: boolean; onChange: (chain: BridgeChainId) => void }) {
  const t = useTranslations("bridge");
  const [instant, setInstant] = useState(false);
  const from = label === "From";
  return <div className={styles.network}>
    <Select.Root value={chain} items={networkItems} disabled={disabled}
      onValueChange={(value) => { if (isBridgeChainId(value)) onChange(value); }}
      onOpenChange={(_, details) => setInstant(details.event.type.startsWith("key"))}>
      <Select.Label className={styles.smallLabel}>{t.rich(from ? "route.from" : "route.to", { sr: (chunks) => <span className="sr-only">{chunks}</span> })}</Select.Label>
      <Select.Trigger type="button" aria-label={t(from ? "route.fromNetwork" : "route.toNetwork")} className={styles.networkTrigger}>
        <NetworkMark chain={chain} />
        <span className={styles.networkCopy}>
          <Select.Value className={styles.networkName} />
          <span className={styles.gasCurrency}>{t("route.gasIn", { symbol: BRIDGE_CHAINS[chain].symbol })}</span>
        </span>
        <Select.Icon className={styles.networkChevron}><ChevronDown size={13} aria-hidden /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner side="bottom" align={label === "From" ? "start" : "end"} sideOffset={8} collisionPadding={16} alignItemWithTrigger={false} className={styles.networkPositioner}>
          <Select.Popup className={styles.networkPopup} data-instant={instant || undefined}>
            <p className={styles.networkMenuTitle}>{t(from ? "route.sendFrom" : "route.receiveOn")}</p>
            <Select.List className={styles.networkList}>
              {BRIDGE_CHAIN_IDS.map((id) => <Select.Item key={id} value={id} label={BRIDGE_CHAINS[id].name} className={styles.networkOption}>
                <NetworkMark chain={id} />
                <span className={styles.networkCopy}>
                  <Select.ItemText className={styles.networkName}>{BRIDGE_CHAINS[id].name}</Select.ItemText>
                  <span className={styles.gasCurrency}>{t("route.gasToken", { symbol: BRIDGE_CHAINS[id].symbol })}</span>
                </span>
                <Select.ItemIndicator className={styles.networkCheck}><Check size={17} strokeWidth={2.5} aria-hidden /></Select.ItemIndicator>
              </Select.Item>)}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  </div>;
}

function Recipient({ address }: { address: string }) {
  const t = useTranslations("bridge");
  return (
    <details className={styles.recipient}>
      <summary><WalletAvatar address={address} size={24} /><span>{t("receivingWallet")}</span><span>{shortAddr(address)}</span><ChevronDown size={13} aria-hidden /></summary>
      <code className={styles.fullAddress}>{address}</code>
    </details>
  );
}

function FeeLimitNotice({ rejection, inputSymbol, gasSymbol }: { rejection: BridgeQuoteRejection; inputSymbol: BridgeAsset; gasSymbol: BridgeAsset }) {
  const t = useTranslations("bridge");
  const feeTooHigh = rejection.reason === "relay-fee";
  const exactPercent = feeTooHigh ? rejection.relayFeePercent : rejection.totalImpactPercent.replace(/^-/, "");
  return <section className={styles.feeLimit} aria-label={t("feeLimit.label")}>
    <div className={styles.feeLimitHeading} role="status" aria-atomic="true">
      <CircleAlert className={styles.feeLimitIcon} size={18} aria-hidden />
      <div className={styles.feeLimitCopy}>
        <h3>{t(feeTooHigh ? "feeLimit.feeTitle" : "feeLimit.lossTitle")}</h3>
        <p>{t("feeLimit.nothingSubmitted")}</p>
      </div>
      <div className={styles.feeLimitPercent}>
        <strong aria-label={t(feeTooHigh ? "feeLimit.feePercent" : "feeLimit.lossPercent", { percent: exactPercent })}>{formatFeeWarningPercent(exactPercent)}<span>%</span></strong>
        <span>{t("feeLimit.limit")}</span>
      </div>
    </div>
    <dl className={styles.feeLimitCosts}>
      <div><dt>{t.rich("feeLimit.relayFee", { note: (chunks) => <span>{chunks}</span> })}</dt><dd title={`${rejection.relayFee} ${inputSymbol}`}>{nativeAmount(rejection.relayFee)} <span>{inputSymbol}</span></dd></div>
      <div><dt>{t.rich("feeLimit.sourceGas", { note: (chunks) => <span>{chunks}</span> })}</dt><dd title={`${rejection.sourceGas} ${gasSymbol}`}>{nativeAmount(rejection.sourceGas)} <span>{gasSymbol}</span></dd></div>
    </dl>
    <details className={styles.feeLimitReason}>
      <summary>{t("feeLimit.why")}<ChevronDown size={14} aria-hidden /></summary>
      <p>{t(feeTooHigh ? "feeLimit.whyFee" : "feeLimit.whyLoss", { percent: exactPercent })}</p>
    </details>
    <p className={styles.feeLimitHint}>{t("feeLimit.hint")}</p>
  </section>;
}

export default function BridgeDialog({ open, onOpenChange, restoreFocus }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  restoreFocus: () => HTMLElement | null;
}) {
  const t = useTranslations("bridge");
  const bridge = useBridge(open);
  const popup = useRef<HTMLDivElement>(null);
  const [connecting, setConnecting] = useState(false);
  const transferring = bridge.tracked !== null;

  function connect() {
    onOpenChange(false);
    setConnecting(true);
  }

  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Backdrop className={styles.backdrop} />
          <Dialog.Popup ref={popup} initialFocus={popup} finalFocus={connecting ? false : restoreFocus} className={styles.panel} onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}>
            <div className={styles.heading}>
              <Dialog.Title className={styles.title}>{t("title")}</Dialog.Title>
              <Dialog.Close className={styles.close} aria-label={t("close")}><X size={19} aria-hidden /></Dialog.Close>
            </div>
            <Dialog.Description className={styles.description}>{transferring ? t("descriptionTransfer") : t("description")}</Dialog.Description>
            {transferring ? <Transfer bridge={bridge} /> : <BridgeForm bridge={bridge} connect={connect} />}
            <div className={styles.footer}>
              <a href="https://relay.link" target="_blank" rel="noreferrer">{t("poweredBy")} <ArrowUpRight size={12} aria-hidden /></a>
              <span>{t("noFee")}</span>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      {connecting ? <WalletPicker onClose={() => { setConnecting(false); onOpenChange(true); }} /> : null}
    </>
  );
}

export function BridgeForm({ bridge: b, connect }: { bridge: Bridge; connect: () => void }) {
  const t = useTranslations("bridge");
  const tc = useTranslations("common");
  if (b.approval && (b.approval.status === "pending" || b.approval.status === "uncertain")) return <ApprovalProgress bridge={b} />;
  const locked = b.busy || b.approvalBusy;
  const loading = locked || b.quoteLoading;
  const reviewing = !!b.quote && !b.quoteExpired;
  const needsRefresh = !!b.quote && b.quoteExpired;
  const origin = BRIDGE_CHAINS[b.originChainId];
  const destination = BRIDGE_CHAINS[b.destinationChainId];
  const inputCurrency = bridgeCurrency(b.originChainId, b.originAsset, "input");
  const outputCurrency = bridgeCurrency(b.destinationChainId, b.destinationAsset, "output");
  const erc20Input = inputCurrency.address !== zeroAddress;
  const convertsAsset = inputCurrency.symbol !== outputCurrency.symbol;
  const outputAmount = (value: string) => nativeAmount(formatUnits(BigInt(value), outputCurrency.decimals));
  const label = b.approvalBusy ? t("action.confirmApproval") : b.allowanceLoading ? t("action.checkingApproval") : b.quoteLoading ? t("action.gettingQuote")
    : b.phase === "switching" ? t("action.confirmSwitch")
    : b.phase === "confirming" ? t("action.confirmWallet")
    : needsRefresh ? t("action.refresh")
    : reviewing && b.approvalRequired ? t("action.approve", { amount: nativeAmount(b.amount) })
    : reviewing ? t("action.bridgeTo", { network: destination.name }) : b.quoteError ? t("action.retry") : !b.canQuote ? t("action.enterAmount") : t("action.getQuote");
  const error = (!b.quoteRejection && b.quoteError) || b.error || b.storageError || b.approvalError;

  return (
    <form onSubmit={(event) => {
      event.preventDefault();
      if (!b.address) { connect(); return; }
      if (loading || b.allowanceLoading || !b.canQuote) return;
      void (reviewing ? b.approvalRequired ? b.approve() : b.confirm() : b.requestQuote());
    }}>
      <div className={styles.route}>
        <NetworkSelect label="From" chain={b.originChainId} disabled={locked} onChange={b.setOriginChainId} />
        <button type="button" className={styles.reverse} aria-label={t("route.reverse", { destination: destination.name, origin: origin.name })} disabled={locked} onClick={b.reverseRoute}><ArrowLeftRight size={18} aria-hidden /></button>
        <NetworkSelect label="To" chain={b.destinationChainId} disabled={locked} onChange={b.setDestinationChainId} />
      </div>
      {convertsAsset ? <p className={styles.conversionNote}>{inputCurrency.symbol} <ArrowRight size={12} aria-hidden /> {outputCurrency.symbol}<span>{t("route.converted")}</span></p> : null}
      {b.originChainId === 4663 || b.destinationChainId === 4663 ? <p className={styles.routeNotice}>{t("route.robinhoodUsdc")}</p> : null}
      {erc20Input && b.approval?.chainId === b.originChainId && b.approval.status === "confirmed" && !b.quote ? <p className={styles.approvalNotice} role="status">{t("form.approvalConfirmed")}</p> : null}

      <div className={styles.amountSection}>
        <label htmlFor="bridge-amount" className={styles.smallLabel}>{t("form.youSend")}</label>
        <div className={styles.amountRow}>
          <input id="bridge-amount" name="bridge-amount" inputMode="decimal" autoComplete="off" spellCheck={false} placeholder="0.00" maxLength={40} value={b.amount} onChange={(event) => b.setAmount(event.target.value)} disabled={locked} aria-describedby="bridge-balance bridge-gas-note" />
          <AssetSelect label="Send" chain={b.originChainId} asset={b.originAsset} disabled={locked} onChange={b.setOriginAsset} />
        </div>
        <p id="bridge-balance" className={styles.balance}>{!b.address ? t("form.balanceOn", { symbol: inputCurrency.symbol, network: origin.name }) : b.balanceLoading ? t("form.checkingBalance") : b.balance !== undefined ? t("form.available", { amount: nativeAmount(formatUnits(b.balance, inputCurrency.decimals)), symbol: inputCurrency.symbol }) : b.balanceError ?? t("form.balanceUnavailable")}</p>
        {b.address && erc20Input && b.originChainId !== 5042 && b.nativeBalance !== undefined ? <p className={styles.balance}>{t("form.forGas", { amount: nativeAmount(b.nativeBalance), symbol: origin.symbol })}</p> : null}
      </div>

      <div className={styles.destinationAsset}><span className={styles.smallLabel}>{t("asset.receiveOn", { network: destination.name })}</span><AssetSelect label="Receive" chain={b.destinationChainId} asset={b.destinationAsset} disabled={locked} onChange={b.setDestinationAsset} /></div>

      {b.quote ? (
        <div className={styles.quote} aria-live="polite">
          <div className={styles.receiveLabel}><span>{t("quote.output")}</span><span className={styles.estimate}>{needsRefresh ? t("quote.expired") : t("quote.live")}</span></div>
          <p className={styles.receiveAmount}>{outputAmount(b.quote.amountOut)}<span><AssetMark asset={outputCurrency.symbol} />{outputCurrency.symbol}</span></p>
          <dl className={styles.fees}>
            <div><dt>{t("quote.minimum")}</dt><dd title={`${formatUnits(BigInt(b.quote.minimumAmountOut), outputCurrency.decimals)} ${outputCurrency.symbol}`}>{outputAmount(b.quote.minimumAmountOut)} {outputCurrency.symbol}</dd></div>
            <div><dt>{t.rich("quote.relayFee", { note: (chunks) => <span>{chunks}</span> })}</dt><dd>{nativeAmount(b.quote.relayFee)} {inputCurrency.symbol}</dd></div>
            <div><dt>{t.rich("quote.sourceGas", { note: (chunks) => <span>{chunks}</span> })}</dt><dd>{nativeAmount(b.quote.sourceGas)} {origin.symbol}</dd></div>
            {convertsAsset ? <div><dt>{t.rich("quote.valueChange", { note: (chunks) => <span>{chunks}</span> })}</dt><dd>{Number(b.quote.totalImpactPercent).toFixed(2)}%</dd></div> : null}
            <div><dt>{t("quote.arrival")}</dt><dd><Clock3 size={12} aria-hidden />{t("quote.seconds", { count: String(Math.max(1, Math.ceil(b.quote.timeEstimate))) })}</dd></div>
          </dl>
          <p className={styles.quoteNotice}>{needsRefresh ? t("quote.expiredNotice") : t("quote.slippage")}</p>
          {b.approvalRequired ? <p className={styles.approvalNotice}>{t("quote.approveFirst", { amount: nativeAmount(b.amount), symbol: origin.symbol })}</p> : null}
        </div>
      ) : b.quoteRejection ? <FeeLimitNotice rejection={b.quoteRejection} inputSymbol={inputCurrency.symbol} gasSymbol={origin.symbol} /> : <div className={styles.previewNote} role="status" aria-live="polite">
        {b.quoteLoading ? <LoaderCircle size={16} className={styles.spinner} aria-hidden /> : <ArrowRight size={16} aria-hidden />}
        <p>{b.quoteLoading ? t("quote.updating") : b.quoteError ? t("quote.none") : b.address ? t("quote.enterAmount") : t("quote.preview")}<br />
          <span>{b.quoteLoading ? t("quote.keepTyping") : t("quote.automatic")}</span></p>
      </div>}

      {b.address ? <Recipient address={b.address} /> : null}
      {error ? <p className={styles.error} role="alert"><CircleAlert size={16} aria-hidden /><span>{error}</span></p> : null}
      <button type="submit" className={styles.primary} disabled={loading || b.allowanceLoading || (!!b.address && !b.canQuote)}>
        {loading ? <LoaderCircle size={17} className={styles.spinner} aria-hidden /> : !b.address ? <Wallet size={17} aria-hidden /> : null}
        {b.address ? label : tc("connectWallet")}
        {!loading && b.address ? <ArrowRight size={17} aria-hidden /> : null}
      </button>
      <p id="bridge-gas-note" className={styles.disclaimer}>{t("form.disclaimer", { symbol: origin.symbol, network: origin.name, converts: convertsAsset ? "yes" : "no", approval: erc20Input ? "yes" : "no" })}</p>
    </form>
  );
}

function ApprovalProgress({ bridge: b }: { bridge: Bridge }) {
  const t = useTranslations("bridge");
  const approval = b.approval!;
  const approvalChain = BRIDGE_CHAINS[approval.chainId];
  const uncertain = approval.status === "uncertain";
  const health = b.approvalHealth;
  const needsAttention = uncertain || (!!health && health.kind !== "waiting");
  const [hash, setHash] = useState("");
  const [verifying, setVerifying] = useState(false);
  return <div className={styles.transfer}>
    <div className={styles.transferRoute}><NetworkMark chain={approval.chainId} /><span>{t("approval.route", { network: approvalChain.name })}</span></div>
    <div className={styles.statusHeading} role="status">
      <span className={styles.statusIcon}>{needsAttention ? <CircleAlert size={26} aria-hidden /> : <LoaderCircle size={26} className={styles.spinner} aria-hidden />}</span>
      <h3>{verifying ? t("approval.verifying") : b.approvalBusy ? t("checkWallet") : uncertain ? t("approval.checkApproval") : health?.title ?? t("health.waiting.title")}</h3>
      <p>{verifying ? t("approval.verifyingDetail", { network: approvalChain.name }) : b.approvalBusy ? t("approval.walletDetail") : uncertain ? t("approval.uncertainDetail") : health?.detail ?? t("approval.waitingDetail", { network: approvalChain.name })}</p>
    </div>
    <dl className={styles.transferDetails}><div><dt>{t("approval.limit")}</dt><dd>{nativeAmount(formatUnits(BigInt(approval.amount), 6))} USDC</dd></div></dl>
    {b.address ? <Recipient address={b.address} /> : null}
    <p className={styles.approvalNotice}>{t("approval.notice")}</p>
    {b.approvalError || b.storageError ? <p className={styles.error} role="alert"><CircleAlert size={16} aria-hidden /><span>{b.approvalError || b.storageError}</span></p> : null}
    {approval.approvalHash ? <a className={styles.externalAction} href={`${approvalChain.explorer}/tx/${approval.approvalHash}`} target="_blank" rel="noreferrer">{t("approval.view", { network: approvalChain.name })} <ArrowUpRight size={17} aria-hidden /></a> : null}
    {!b.approvalBusy ? <details className={styles.approvalRecovery}>
      <summary>{approval.approvalHash ? t("approval.spedUp") : t("approval.haveHash")}</summary>
      <p>{t("approval.recoverHelp", { network: approvalChain.name })}</p>
      <form onSubmit={(event) => { event.preventDefault(); setVerifying(true); void b.recoverApproval(hash.trim()).finally(() => setVerifying(false)); }}>
        <label htmlFor="bridge-approval-hash" className={styles.smallLabel}>{t("approval.hash")}</label>
        <input id="bridge-approval-hash" value={hash} onChange={(event) => setHash(event.target.value)} placeholder="0x…" maxLength={66} autoComplete="off" spellCheck={false} />
        <button type="submit" className={styles.newTransfer} disabled={verifying || !/^0x[0-9a-fA-F]{64}$/.test(hash.trim())}>{t("approval.verify")}</button>
      </form>
    </details> : null}
    {approval.approvalHash ? <button type="button" className={styles.newTransfer} disabled={b.approvalBusy} onClick={b.retryApproval}>{t("approval.checkStatus")}</button> : null}
    {b.approvalCanBeDiscarded ? <details className={styles.approvalRecovery}>
      <summary>{t("approval.stillPending", { minutes: String(DISCARD_AFTER_MS / 60_000) })}</summary>
      <p>{t("approval.discardHelp")}</p>
      <button type="button" className={styles.newTransfer} disabled={b.approvalBusy || b.discarding} onClick={b.discardApproval}>{b.discarding ? t("approval.checking") : t("approval.discard")}</button>
    </details> : null}
    <p className={styles.disclaimer}>{t("approval.resume")}</p>
  </div>;
}

export function Transfer({ bridge: b }: { bridge: Bridge }) {
  const t = useTranslations("bridge");
  const transfer = b.tracked!;
  const success = b.phase === "success";
  const refund = b.phase === "refund";
  const failed = b.phase === "failure";
  const reverted = transfer.failureReason === "source-reverted";
  const uncertain = b.phase === "uncertain";
  const waitingForWallet = b.phase === "confirming" || b.phase === "switching";
  const terminal = success || refund || failed;
  const origin = BRIDGE_CHAINS[transfer.originChainId];
  const destination = BRIDGE_CHAINS[transfer.destinationChainId];
  const inputCurrency = bridgeTransferInputCurrency(transfer);
  const outputCurrency = bridgeCurrency(transfer.destinationChainId, transfer.destinationAsset, "output");
  const title = success ? t("transfer.arrived", { network: destination.name }) : refund ? t("transfer.refund") : reverted ? t("transfer.reverted") : failed ? t("transfer.attention") : uncertain ? t("transfer.checking") : waitingForWallet ? t("checkWallet") : t("transfer.onItsWay");
  const detail = success ? t("transfer.arrivedDetail", { symbol: outputCurrency.symbol }) : refund ? t("transfer.refundDetail") : reverted ? t("transfer.revertedDetail", { symbol: inputCurrency.symbol }) : failed ? t("transfer.failedDetail") : uncertain ? t("transfer.uncertainDetail") : waitingForWallet ? t("transfer.walletDetail") : t("transfer.pendingDetail");

  return (
    <div className={styles.transfer}>
      <div className={styles.transferRoute}><NetworkMark chain={transfer.originChainId} /><span>{origin.name}</span><ArrowRight size={16} aria-hidden /><NetworkMark chain={transfer.destinationChainId} /><span>{destination.name}</span></div>
      <div className={styles.statusHeading} role="status">
        <span className={`${styles.statusIcon} ${success ? styles.success : ""}`}>{success ? <Check size={26} aria-hidden /> : terminal || uncertain ? <CircleAlert size={26} aria-hidden /> : <LoaderCircle size={26} className={styles.spinner} aria-hidden />}</span>
        <h3>{title}</h3><p>{detail}</p>
      </div>
      <dl className={styles.transferDetails}>
        <div><dt>{t("transfer.amountSent")}</dt><dd className={styles.transferAmount}><AssetMark asset={inputCurrency.symbol} size={20} />{nativeAmount(formatUnits(BigInt(transfer.amount), inputCurrency.decimals))} {inputCurrency.symbol}</dd></div>
      </dl>
      <Recipient address={transfer.address} />
      <ol className={styles.steps} aria-label={t("transfer.progress")}>
        <li data-complete={!reverted && (!!transfer.sourceHash || success || refund)}><span>{!reverted && (transfer.sourceHash || success || refund) ? <Check size={13} aria-hidden /> : "1"}</span><div><strong>{t("transfer.depositOn", { network: origin.name })}</strong><small>{reverted ? t("transfer.depositReverted") : transfer.sourceHash || success || refund ? t("transfer.depositSubmitted") : waitingForWallet ? t("transfer.awaitingWallet") : t("transfer.findingDeposit")}</small></div></li>
        <li data-complete={success}><span>{success ? <Check size={13} aria-hidden /> : "2"}</span><div><strong>{refund ? t("transfer.refundReported") : t("transfer.relayProcesses")}</strong><small>{transfer.status === "delayed" ? t("transfer.delayed") : failed ? t("transfer.failedHelp") : success ? t("transfer.complete") : t("transfer.liveStatus")}</small></div></li>
        <li data-complete={success}><span>{success ? <Check size={13} aria-hidden /> : "3"}</span><div><strong>{t("transfer.receiveOn", { symbol: outputCurrency.symbol, network: destination.name })}</strong><small>{success ? t("transfer.delivered") : t("transfer.deliveryPending")}</small></div></li>
      </ol>
      {b.error || b.statusError || b.storageError ? <p className={styles.error} role="alert"><CircleAlert size={16} aria-hidden /><span>{b.error || b.statusError || b.storageError}{b.statusError ? <button type="button" className={styles.inlineButton} onClick={b.retryStatus}>{t("transfer.checkAgain")}</button> : null}</span></p> : null}
      <a className={styles.externalAction} href={`https://relay.link/transaction/${transfer.requestId}`} target="_blank" rel="noreferrer">{t("transfer.viewOnRelay")}<ArrowUpRight size={17} aria-hidden /></a>
      <div className={styles.explorerLinks}>
        {transfer.sourceHash ? <a href={`${origin.explorer}/tx/${transfer.sourceHash}`} target="_blank" rel="noreferrer">{t("transfer.sourceTransaction")} <ArrowUpRight size={12} aria-hidden /></a> : null}
        {success && transfer.destinationHashes[0] ? <a href={`${destination.explorer}/tx/${transfer.destinationHashes[0]}`} target="_blank" rel="noreferrer">{t("transfer.destinationTransaction")} <ArrowUpRight size={12} aria-hidden /></a> : null}
      </div>
      {b.canReset ? <button type="button" className={styles.newTransfer} onClick={b.reset}>{t("transfer.newBridge")}<ChevronRight size={15} aria-hidden /></button> : null}
      {b.canDiscard ? <details className={styles.approvalRecovery}>
        <summary>{t("transfer.noDeposit", { minutes: String(DISCARD_AFTER_MS / 60_000) })}</summary>
        <p>{t("transfer.discardHelp", { network: origin.name })}</p>
        <button type="button" className={styles.newTransfer} disabled={b.discarding} onClick={b.discard}>{b.discarding ? t("transfer.checkingTransfer") : t("transfer.discard")}</button>
      </details> : null}
      <p className={styles.disclaimer}>{t("transfer.id")} <span className={styles.requestId}>{transfer.requestId}</span></p>
    </div>
  );
}
