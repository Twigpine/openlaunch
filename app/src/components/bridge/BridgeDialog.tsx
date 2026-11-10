"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import Link from "next/link";
import { Dialog } from "@base-ui/react/dialog";
import { Select } from "@base-ui/react/select";
import { ArrowLeft, ArrowLeftRight, ArrowRight, ArrowUpRight, Check, ChevronDown, ChevronRight, CircleAlert, CircleDollarSign, Clock3, Coins, Copy, Fuel, History, Info, LoaderCircle, Wallet, X } from "lucide-react";
import { formatEther, formatUnits, zeroAddress, type Address } from "viem";
import { BRIDGE_ASSET_NAMES, BRIDGE_CHAINS, BRIDGE_SEND_ASSETS, BRIDGE_CHAIN_IDS, BRIDGE_DESTINATION_IDS, bridgeCurrency, bridgeAssets, bridgeProviderName, bridgeTokenAsset, bridgeTransferInputCurrency, isBridgeAssetSupported, isBridgeChainId, isBridgeFundingChain, type BridgeAsset, type BridgeChainId, type BridgeQuoteRejection } from "@/lib/bridge/types";
import { DISCARD_AFTER_MS } from "@/lib/bridge/client";
import { CCTP_APPROVAL_SPENDER } from "@/lib/bridge/approval";
import { bridgeLinkKey, type BridgeLink } from "@/lib/bridge/link";
import { signalCaption, signalMode } from "@/lib/bridge/signal";
import { formatFeeWarningPercent } from "@/lib/bridge/fee-display";
import { EXCHANGE_NETWORKS, EXCHANGE_OPEN_KEY, EXCHANGE_POLL_MS, exchangeGuideOpen, exchangeNeedsGas, exchangeNext, type ExchangeArrival } from "@/lib/bridge/exchange";
import { formatFundAmount } from "@/lib/bridge/fund";
import { shortAddr } from "@/lib/chainPublic";
import WalletPicker from "../WalletPicker";
import WalletAvatar from "../WalletAvatar";
import useBridge from "./useBridge";
import SignalBoard from "./SignalBoard";
import SlideConfirm from "./SlideConfirm";
import useExchangeWatch, { clearExchangeWatch, type ExchangeView } from "./useExchangeWatch";
import { dotFont } from "./dot-font";
import styles from "./BridgeDialog.module.css";
import signal from "./Signal.module.css";

type Bridge = ReturnType<typeof useBridge>;
// Money leaves from any network, funding ones included, but arrives only on a launch chain.
const SOURCE_CHAINS: readonly BridgeChainId[] = BRIDGE_CHAIN_IDS;
const DESTINATION_CHAINS: readonly BridgeChainId[] = BRIDGE_DESTINATION_IDS;

function nativeAmount(value: string | bigint): string {
  const text = typeof value === "bigint" ? formatEther(value) : value;
  const [whole, decimal = ""] = text.split(".");
  const cut = decimal.slice(0, 7).replace(/0+$/, "");
  return whole === "0" && !cut && /[1-9]/.test(decimal) ? "<0.0000001" : `${whole}${cut ? `.${cut}` : ""}`;
}

function NetworkMark({ chain }: { chain: BridgeChainId }) {
  if (chain === 42161) return <span className={`${styles.networkMark} ${styles.arbitrumMark}`} aria-hidden><Image src="/brand/arbitrum.svg" alt="" width={22} height={24} draggable={false} /></span>;
  if (chain === 10) return <span className={styles.networkMark} aria-hidden><Image src="/brand/optimism.svg" alt="" width={28} height={28} draggable={false} /></span>;
  if (chain === 1) return <span className={styles.networkMark} aria-hidden><Image src="/brand/ethereum.svg" alt="" width={28} height={28} draggable={false} /></span>;
  // a black disc on white, its own tile on both themes (ChainLogo.tsx)
  if (chain === 99901) return <span className={`${styles.networkMark} ${styles.elysiumMark}`} aria-hidden><Image src="/brand/elysium.png" alt="" width={28} height={28} draggable={false} /></span>;
  return <span className={`${styles.networkMark} ${chain === 5042 ? styles.arcMark : ""}`} aria-hidden>{chain === 8453
    ? <Image src="/brand/base.svg" alt="" width={30} height={30} draggable={false} />
    : chain === 5042 ? <Image src="/brand/arc.svg" alt="" width={23} height={24} draggable={false} />
    : <>
      <Image className={styles.lightLogo} src="/brand/robinhood-black.svg" alt="" width={23} height={30} draggable={false} />
      <Image className={styles.darkLogo} src="/brand/robinhood-white.svg" alt="" width={23} height={30} draggable={false} />
    </>}</span>;
}

function AssetMark({ asset, size = 24 }: { asset: BridgeAsset; size?: number }) {
  // USDG has no bundled logo: it takes the plain dollar glyph the launch form gives it
  if (asset === "USDG") return <CircleDollarSign size={size} strokeWidth={1.75} aria-hidden />;
  // nor does HYPE: the launch form's coin glyph again
  if (asset === "HYPE") return <Coins size={size} strokeWidth={1.75} aria-hidden />;
  return <Image src={asset === "USDC" ? "/brand/usdc.svg" : "/brand/ethereum.svg"} alt="" width={size} height={size} draggable={false} aria-hidden />;
}

function AssetSelect({ label, chain, asset, disabled, onChange }: { label: "Send" | "Receive"; chain: BridgeChainId; asset: BridgeAsset; disabled: boolean; onChange: (asset: BridgeAsset) => void }) {
  const [instant, setInstant] = useState(false);
  const side = label === "Send" ? "input" : "output";
  const choices = bridgeAssets(chain, side);
  if (choices.length === 1) return (
    <span className={styles.fixedAsset}>
      <span className={styles.currency} aria-label={`${label} token: ${asset}`}><AssetMark asset={asset} size={28} />{asset}</span>
      {chain === 99901 ? <span className={styles.assetRequirement}>USDC only · Gas in HYPE</span> : null}
    </span>
  );
  return <Select.Root value={asset} items={choices.map((value) => ({ value, label: value }))} disabled={disabled}
    onValueChange={(value) => { if (isBridgeAssetSupported(chain, value, side)) onChange(value); }}
    onOpenChange={(_, details) => setInstant(details.event.type.startsWith("key"))}>
    <Select.Trigger type="button" aria-label={`${label} token`} className={styles.assetTrigger}>
      <AssetMark asset={asset} size={28} /><Select.Value /><Select.Icon className={styles.networkChevron}><ChevronDown size={14} aria-hidden /></Select.Icon>
    </Select.Trigger>
    <Select.Portal>
      <Select.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={16} alignItemWithTrigger={false} className={styles.networkPositioner}>
        <Select.Popup className={styles.networkPopup} data-instant={instant || undefined}>
          <p className={styles.networkMenuTitle}>{label} on {BRIDGE_CHAINS[chain].name}</p>
          <Select.List className={styles.networkList}>
            {choices.map((value) => <Select.Item key={value} value={value} label={value} className={styles.networkOption}>
              <AssetMark asset={value} size={30} />
              <span className={styles.networkCopy}><Select.ItemText className={styles.networkName}>{value}</Select.ItemText><span className={styles.gasCurrency}>{BRIDGE_ASSET_NAMES[value]} · {value === BRIDGE_CHAINS[chain].symbol ? "Gas token" : `Gas in ${BRIDGE_CHAINS[chain].symbol}`}</span></span>
              <Select.ItemIndicator className={styles.networkCheck}><Check size={17} strokeWidth={2.5} aria-hidden /></Select.ItemIndicator>
            </Select.Item>)}
          </Select.List>
        </Select.Popup>
      </Select.Positioner>
    </Select.Portal>
  </Select.Root>;
}

function NetworkSelect({ label, chain, disabled, onChange }: { label: "From" | "To"; chain: BridgeChainId; disabled: boolean; onChange: (chain: BridgeChainId) => void }) {
  const [instant, setInstant] = useState(false);
  const chains = label === "From" ? SOURCE_CHAINS : DESTINATION_CHAINS;
  const launch = chains.filter((id) => !isBridgeFundingChain(id));
  const funding = chains.filter(isBridgeFundingChain);
  const option = (id: BridgeChainId) => <Select.Item key={id} value={id} label={BRIDGE_CHAINS[id].name} className={styles.networkOption}>
    <NetworkMark chain={id} />
    <span className={styles.networkCopy}>
      <Select.ItemText className={styles.networkName}>{BRIDGE_CHAINS[id].name}</Select.ItemText>
      <span className={styles.gasCurrency}>{BRIDGE_CHAINS[id].symbol} · Gas token</span>
    </span>
    <Select.ItemIndicator className={styles.networkCheck}><Check size={17} strokeWidth={2.5} aria-hidden /></Select.ItemIndicator>
  </Select.Item>;
  return <div className={styles.network}>
    <Select.Root value={chain} items={chains.map((id) => ({ value: id, label: BRIDGE_CHAINS[id].name }))} disabled={disabled}
      onValueChange={(value) => { if (isBridgeChainId(value)) onChange(value); }}
      onOpenChange={(_, details) => setInstant(details.event.type.startsWith("key"))}>
      <Select.Label className={styles.smallLabel}>{label}<span className="sr-only"> network</span></Select.Label>
      <Select.Trigger type="button" aria-label={`${label} network`} className={styles.networkTrigger}>
        <NetworkMark chain={chain} />
        <span className={styles.networkCopy}>
          <Select.Value className={styles.networkName} />
          <span className={styles.gasCurrency}>Gas in {BRIDGE_CHAINS[chain].symbol}</span>
        </span>
        <Select.Icon className={styles.networkChevron}><ChevronDown size={13} aria-hidden /></Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner side="bottom" align={label === "From" ? "start" : "end"} sideOffset={8} collisionPadding={16} alignItemWithTrigger={false} className={styles.networkPositioner}>
          <Select.Popup className={styles.networkPopup} data-instant={instant || undefined}>
            <p className={styles.networkMenuTitle}>{label === "From" ? "Send from" : "Receive on"}</p>
            <Select.List className={styles.networkList}>
              {launch.map(option)}
              {funding.length > 0 ? <Select.Group className={styles.networkList}>
                <Select.GroupLabel className={styles.networkGroupLabel}>Fund from</Select.GroupLabel>
                {funding.map(option)}
              </Select.Group> : null}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  </div>;
}

function Recipient({ address }: { address: string }) {
  return (
    <details className={styles.recipient}>
      <summary><WalletAvatar address={address} size={24} /><span>Receiving wallet</span><span>{shortAddr(address)}</span><ChevronDown size={13} aria-hidden /></summary>
      <code className={styles.fullAddress}>{address}</code>
    </details>
  );
}

function FeeLimitNotice({ rejection, inputSymbol, gasSymbol }: { rejection: BridgeQuoteRejection; inputSymbol: BridgeAsset; gasSymbol: string }) {
  const feeTooHigh = rejection.reason === "relay-fee";
  const exactPercent = feeTooHigh ? rejection.relayFeePercent : rejection.totalImpactPercent.replace(/^-/, "");
  return <section className={styles.feeLimit} aria-label="Quote above safety limit">
    <div className={styles.feeLimitHeading} role="status" aria-atomic="true">
      <CircleAlert className={styles.feeLimitIcon} size={18} aria-hidden />
      <div className={styles.feeLimitCopy}>
        <h3>{feeTooHigh ? "Bridge fee too high" : "Quote loss too high"}</h3>
        <p>Nothing has been submitted.</p>
      </div>
      <div className={styles.feeLimitPercent}>
        <strong aria-label={`${feeTooHigh ? "Relay fee" : "Quote loss"}: ${exactPercent}%`}>{formatFeeWarningPercent(exactPercent)}<span>%</span></strong>
        <span>5% safety limit</span>
      </div>
    </div>
    <dl className={styles.feeLimitCosts}>
      <div><dt>Relay fee <span>Included</span></dt><dd title={`${rejection.relayFee} ${inputSymbol}`}>{nativeAmount(rejection.relayFee)} <span>{inputSymbol}</span></dd></div>
      <div><dt>Source gas <span>Extra · estimated</span></dt><dd title={`${rejection.sourceGas} ${gasSymbol}`}>{nativeAmount(rejection.sourceGas)} <span>{gasSymbol}</span></dd></div>
    </dl>
    <details className={styles.feeLimitReason}>
      <summary>Why is this blocked?<ChevronDown size={14} aria-hidden /></summary>
      <p>{feeTooHigh ? `Relay’s fee is ${exactPercent}% of your amount.` : `This quote loses ${exactPercent}% in conversion and fees.`} Openlaunch blocks quotes above 5%. Source gas is extra and is not included in this limit.</p>
    </details>
    <p className={styles.feeLimitHint}>Change the amount or route. Your quote updates automatically.</p>
  </section>;
}

/**
 * The bridge's one controller. It shows the panel as the header dialog, or, when the /bridge page has registered its
 * slot (bridge-slot.ts), inside that page instead: the same hook either way, so a transfer is quoted, sent and tracked
 * once. `link` is the page's shareable route (lib/bridge/link.ts); it only preselects networks and tokens.
 */
export default function BridgeDialog({ open, onOpenChange, restoreFocus, slot = null, link = null, linkCount = 0 }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  restoreFocus: () => HTMLElement | null;
  slot?: HTMLElement | null;
  link?: BridgeLink | null;
  /** Bumped by each request for a route, so asking for the same route again re-applies it. */
  linkCount?: number;
}) {
  const onPage = slot !== null;
  const bridge = useBridge(open || onPage);
  const [connecting, setConnecting] = useState(false);
  const transferring = bridge.tracked !== null;
  const linkKey = link ? `${linkCount}:${bridgeLinkKey(link)}` : "";
  const appliedLink = useRef("");

  // Each link is applied once, through the same guarded setters the pickers use: they refuse while an approval or a
  // transfer is in progress, so a link can never move a route out from under one.
  useEffect(() => {
    if (!link || appliedLink.current === linkKey) return;
    appliedLink.current = linkKey;
    bridge.setOriginChainId(link.originChainId);
    bridge.setDestinationChainId(link.destinationChainId);
    if (link.originAsset) bridge.setOriginAsset(link.originAsset);
    if (link.destinationAsset) bridge.setDestinationAsset(link.destinationAsset);
  }, [bridge, link, linkKey]);

  function connect() {
    if (!onPage) onOpenChange(false);
    setConnecting(true);
  }

  const circle = (bridge.tracked?.provider ?? bridge.quote?.provider) === "cctp";
  const footer = <BridgeFooter circle={circle} hideHistory={onPage} onHistory={() => onOpenChange(false)} />;
  const content = transferring ? <Transfer bridge={bridge} /> : <BridgeForm bridge={bridge} connect={connect} />;

  return (
    <>
      {onPage ? createPortal(<section className={signal.pagePanel} aria-label="Bridge">{content}{footer}</section>, slot) : null}
      <BridgeModal
        open={open && !onPage}
        onOpenChange={onOpenChange}
        description={transferring ? "Track your transfer to arrival." : "Same wallet on a new network."}
        footer={footer}
        finalFocus={connecting ? false : restoreFocus}
      >
        {content}
      </BridgeModal>
      {connecting ? <WalletPicker onClose={() => { setConnecting(false); if (!onPage) onOpenChange(true); }} /> : null}
    </>
  );
}

export function BridgeModal({ open, onOpenChange, description, children, footer, finalFocus, closeLabel = "Close bridge" }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  description: string;
  children: ReactNode;
  footer: ReactNode;
  finalFocus?: false | (() => HTMLElement | null);
  closeLabel?: string;
}) {
  const popup = useRef<HTMLDivElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={styles.backdrop} />
        <Dialog.Popup ref={popup} initialFocus={popup} finalFocus={finalFocus} className={styles.panel} onKeyDown={(event) => { if (event.key === "Escape") event.stopPropagation(); }}>
          <header className={styles.dialogHeader}>
            <span className={styles.headerMark} aria-hidden><ArrowLeftRight size={19} /></span>
            <div className={styles.headingCopy}>
              <Dialog.Title className={styles.title}>Bridge</Dialog.Title>
              <Dialog.Description className={styles.description}>{description}</Dialog.Description>
            </div>
            <Dialog.Close className={styles.close} aria-label={closeLabel}><X size={19} aria-hidden /></Dialog.Close>
          </header>
          <div className={styles.dialogBody}>{children}</div>
          {footer}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function BridgeFooter({ circle, hideHistory = false, historyHref = "/bridge#transfers", onHistory }: {
  circle: boolean;
  hideHistory?: boolean;
  historyHref?: string;
  onHistory?: () => void;
}) {
  const provider = circle ? "Circle CCTP" : "Relay";
  return (
    <div className={styles.footer}>
      <div className={styles.footerMeta}>
        <a className={styles.providerLink} href={circle ? "https://developers.circle.com/cctp" : "https://relay.link"} target="_blank" rel="noreferrer">
          Via {provider} <ArrowUpRight size={12} aria-hidden />
        </a>
        <span className={styles.feeLabel} title="0% Openlaunch fee"><strong>0%</strong> app fee</span>
      </div>
      {hideHistory ? null : <Link className={styles.historyLink} href={historyHref} onClick={onHistory}><History size={15} aria-hidden />Your transfers</Link>}
    </div>
  );
}

/**
 * `exchangeView` stands in for the live balance watch in the development fixture, so its guide never reads a network.
 */
export function BridgeForm({ bridge: b, connect, idPrefix = "bridge", exchangeView }: { bridge: Bridge; connect: () => void; idPrefix?: string; exchangeView?: ExchangeView }) {
  // "opened" from the form's link takes focus; "resumed" (left open in this tab: the panel closed while waiting, or a
  // wallet connected from it) does not, so reopening the panel or loading /bridge never jumps to it
  const [guide, setGuide] = useState<false | "opened" | "resumed">(false);
  useEffect(() => {
    const resume = () => { try { if (exchangeGuideOpen(window.sessionStorage.getItem(EXCHANGE_OPEN_KEY), Date.now())) setGuide((open) => open || "resumed"); } catch { /* not kept */ } };
    resume();
  }, []);
  if (b.approval && (b.approval.status === "pending" || b.approval.status === "uncertain")) return <ApprovalProgress bridge={b} />;
  const amountId = `${idPrefix}-amount`;
  const balanceId = `${idPrefix}-balance`;
  const gasNoteId = `${idPrefix}-gas-note`;
  const exchangeLinkId = `${idPrefix}-exchange-link`;
  const openGuide = () => {
    try { window.sessionStorage.setItem(EXCHANGE_OPEN_KEY, String(Date.now())); } catch { /* open for this view only */ }
    setGuide("opened");
  };
  // back in the form, focus lands where the guide left off: its link, or the amount it filled in
  const closeGuide = (focus: string) => {
    clearExchangeWatch();
    setGuide(false);
    window.requestAnimationFrame(() => document.getElementById(focus)?.focus());
  };
  if (guide) {
    const bridgeFrom = (arrival: ExchangeArrival) => {
      const next = exchangeNext(arrival, b.destinationChainId);
      if (next.kind === "bridge") {
        b.setOriginChainId(next.originChainId);
        b.setOriginAsset(next.originAsset);
        if (next.amount) b.setAmount(next.amount);
      }
      closeGuide(next.kind === "bridge" ? amountId : exchangeLinkId);
    };
    const props = { address: b.address, destinationChainId: b.destinationChainId, focusOnMount: guide === "opened", onBridge: bridgeFrom, onBack: () => closeGuide(exchangeLinkId), onConnect: connect };
    return exchangeView ? <ExchangeGuide {...props} view={exchangeView} /> : <LiveExchangeGuide {...props} />;
  }
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
  const provider = bridgeProviderName(b.quote?.provider);
  const circle = b.quote?.provider === "cctp";
  // a wallet sitting on a funding network most likely wants to send from it
  const walletFunding = b.address && isBridgeFundingChain(b.walletChainId) && b.walletChainId !== b.originChainId ? b.walletChainId : null;
  const outputAmount = (value: string) => nativeAmount(formatUnits(BigInt(value), outputCurrency.decimals));
  const label = b.approvalBusy ? `Confirm ${inputCurrency.symbol} approval…` : b.allowanceLoading ? `Checking ${inputCurrency.symbol} permission…` : b.quoteLoading ? "Getting your quote…"
    : b.phase === "switching" ? "Confirm network switch…"
    : b.phase === "confirming" ? "Confirm in your wallet…"
    : needsRefresh ? "Refresh quote"
    : reviewing && b.approvalRequired ? `Approve ${nativeAmount(b.amount)} ${inputCurrency.symbol}`
    : reviewing ? `Bridge to ${destination.name}` : b.quoteError ? "Retry quote" : !b.canQuote ? "Enter an amount" : "Get quote";
  const error = (!b.quoteRejection && b.quoteError) || b.error || b.storageError || b.approvalError;
  const quoteHint = b.quoteLoading ? "Getting quote…" : b.quoteError ? "Quote unavailable"
    : b.address ? "Enter amount for a quote" : "Connect to see a quote";
  const mode = signalMode({ phase: b.phase, tracked: false, approvalActive: b.approvalBusy, quoteLoading: b.quoteLoading, reviewing, quoteExpired: needsRefresh, blocked: !!b.quoteRejection || !!b.quoteError });
  // the deposit, and only the deposit, can also be confirmed by sliding: never an approval, a quote or a refresh
  const slideReady = !!b.address && reviewing && !b.approvalRequired && !loading && !b.allowanceLoading;
  const actionDisabled = loading || b.allowanceLoading || (!!b.address && !b.canQuote);
  const quoteAction = !!b.address && !reviewing;

  function runWalletAction() {
    if (actionDisabled) return;
    if (!b.address) { connect(); return; }
    if (reviewing) void (b.approvalRequired ? b.approve() : b.confirm());
  }

  return (
    <form className={dotFont.variable} onSubmit={(event) => {
      event.preventDefault();
      // Enter from the amount field can fetch a quote. Wallet actions use the button or slider.
      if (quoteAction && !actionDisabled) void b.requestQuote();
    }}>
      <SignalBoard from={b.originChainId} to={b.destinationChainId} mode={mode} caption={signalCaption(mode, destination.name)} />
      <div className={styles.route}>
        <NetworkSelect label="From" chain={b.originChainId} disabled={locked} onChange={b.setOriginChainId} />
        <button type="button" className={styles.reverse} aria-label={b.canReverse ? `Reverse route: ${destination.name} to ${origin.name}` : `${origin.name} only sends funds here`} title={b.canReverse ? undefined : `${origin.name} only sends funds here`} disabled={locked || !b.canReverse} onClick={b.reverseRoute}><ArrowLeftRight size={18} aria-hidden /></button>
        <NetworkSelect label="To" chain={b.destinationChainId} disabled={locked} onChange={b.setDestinationChainId} />
      </div>
      {walletFunding !== null ? <button type="button" className={styles.walletHint} disabled={locked} onClick={() => b.setOriginChainId(walletFunding)}>Your wallet is on {BRIDGE_CHAINS[walletFunding].name}. Send from {BRIDGE_CHAINS[walletFunding].name}</button> : null}
      {convertsAsset ? <p className={styles.conversionNote}>{inputCurrency.symbol} <ArrowRight size={12} aria-hidden /> {outputCurrency.symbol}<span>Converted by Relay</span></p> : null}
      {b.originChainId === 4663 || b.destinationChainId === 4663 ? (
        <details className={styles.routeAvailability}>
          <summary><Info size={14} aria-hidden /><span>Robinhood supports ETH and USDG</span><ChevronDown size={14} aria-hidden /></summary>
          <p>USDC routes on Robinhood are unavailable because they don’t pass our current safety checks.</p>
        </details>
      ) : null}
      {b.destinationChainId === 99901 && b.destinationAsset !== "HYPE" ? <button type="button" className={styles.walletHint} disabled={locked} onClick={() => b.setDestinationAsset("HYPE")}>Gas on Elysium is paid in HYPE. With none there yet, receive HYPE instead</button> : null}
      {erc20Input && b.approval?.chainId === b.originChainId && b.approval.status === "confirmed" && !b.quote ? <p className={styles.approvalNotice} role="status">{inputCurrency.symbol} approval confirmed. Review a fresh quote before bridging. No funds have been bridged yet.</p> : null}

      <div className={styles.amountStack}>
        <div className={styles.amountSection}>
          <label htmlFor={amountId} className={styles.smallLabel}>You send</label>
          <div className={styles.amountRow}>
            <input id={amountId} name="bridge-amount" inputMode="decimal" autoComplete="off" spellCheck={false} placeholder="0.00" maxLength={40} value={b.amount} onChange={(event) => b.setAmount(event.target.value)} disabled={locked} aria-describedby={`${balanceId} ${gasNoteId}`} />
            <AssetSelect label="Send" chain={b.originChainId} asset={b.originAsset} disabled={locked} onChange={b.setOriginAsset} />
          </div>
          <p id={balanceId} className={styles.balance}>{!b.address ? `${inputCurrency.symbol} on ${origin.name}` : b.balanceLoading ? "Checking your balance…" : b.balance !== undefined ? `Available: ${nativeAmount(formatUnits(b.balance, inputCurrency.decimals))} ${inputCurrency.symbol}` : b.balanceError ?? "Balance unavailable"}</p>
          {b.address && erc20Input && b.originChainId !== 5042 && b.nativeBalance !== undefined ? <p className={styles.balance}>For gas: {nativeAmount(b.nativeBalance)} {origin.symbol}</p> : null}
          {!reviewing ? <button type="button" id={exchangeLinkId} className={styles.exchangeLink} disabled={locked} onClick={openGuide}>Funds on an exchange? Withdraw them to this wallet first</button> : null}
        </div>
        <div className={styles.destinationAsset}>
          <div className={styles.receiveCopy}>
            <span className={styles.smallLabel}>Receive on {destination.name}</span>
            <span className={styles.quoteHint} role="status">
              {!b.quote && !b.quoteRejection ? <>
                {b.quoteLoading ? <LoaderCircle size={12} className={styles.spinner} aria-hidden /> : null}
                {quoteHint}
              </> : null}
            </span>
          </div>
          <AssetSelect label="Receive" chain={b.destinationChainId} asset={b.destinationAsset} disabled={locked} onChange={b.setDestinationAsset} />
        </div>
      </div>

      {b.quote ? (
        <div className={styles.quote} aria-live="polite">
          <div className={styles.receiveLabel}><span>Estimated output</span><span className={styles.estimate}>{needsRefresh ? "Quote expired" : "Live quote"}</span></div>
          <p className={styles.receiveAmount}>{outputAmount(b.quote.amountOut)}<span><AssetMark asset={outputCurrency.symbol} />{outputCurrency.symbol}</span></p>
          <dl className={styles.fees}>
            <div><dt>Minimum received</dt><dd title={`${formatUnits(BigInt(b.quote.minimumAmountOut), outputCurrency.decimals)} ${outputCurrency.symbol}`}>{outputAmount(b.quote.minimumAmountOut)} {outputCurrency.symbol}</dd></div>
            <div><dt>Route</dt><dd>{circle ? "Circle CCTP" : "Relay"}</dd></div>
            <div><dt>{provider} fee <span>(included)</span></dt><dd>{nativeAmount(b.quote.relayFee)} {inputCurrency.symbol}</dd></div>
            <div><dt>Source gas <span>(extra, estimated)</span></dt><dd>{nativeAmount(b.quote.sourceGas)} {origin.symbol}</dd></div>
            {convertsAsset ? <div><dt>Value change <span>(conversion + fees)</span></dt><dd>{Number(b.quote.totalImpactPercent).toFixed(2)}%</dd></div> : null}
            <div><dt>Estimated arrival</dt><dd><Clock3 size={12} aria-hidden />{Math.max(1, Math.ceil(b.quote.timeEstimate))} seconds</dd></div>
          </dl>
          <p className={styles.quoteNotice}>{needsRefresh ? "This quote expired. Refresh and review the new amounts." : circle ? "Circle takes one fixed fee, so this is the exact amount you receive. Arrival time and gas can change." : "0.5% slippage limit. Arrival time and gas can change."}</p>
          {b.approvalRequired ? <p className={styles.approvalNotice}>First, approve only {nativeAmount(b.amount)} {inputCurrency.symbol} for {circle ? "Circle’s transfer contract" : "Relay’s deposit contract"}. Then review a fresh quote and confirm the bridge separately. Approval alone does not move your funds and uses additional {origin.symbol} for gas.</p> : null}
        </div>
      ) : b.quoteRejection ? <FeeLimitNotice rejection={b.quoteRejection} inputSymbol={inputCurrency.symbol} gasSymbol={origin.symbol} /> : null}

      {b.address ? <Recipient address={b.address} /> : null}
      {error ? <p className={styles.error} role="alert"><CircleAlert size={16} aria-hidden /><span>{error}</span></p> : null}
      <details className={styles.safety}>
        <summary>
          <span className={styles.gasLabel} id={gasNoteId}><Fuel size={14} aria-hidden />Gas in {origin.symbol} on {origin.name}</span>
          <span className={styles.safetyToggle}>Details <ChevronDown size={13} aria-hidden /></span>
        </summary>
        <div className={styles.safetyCopy}>
          <p>Keep some {origin.symbol} on {origin.name} for gas. {convertsAsset ? "Relay converts the asset at the quoted rate. " : ""}{erc20Input ? `An unused ${inputCurrency.symbol} approval stays active until you use or revoke it.` : "No token approvals required."}</p>
          <p>Bridging uses {provider}, a third-party protocol, and carries risk. Openlaunch does not operate {provider}, holds no funds in transit, and is not responsible for delays, refunds or losses.</p>
        </div>
      </details>
      <div className={styles.formActions} data-pin={!b.quote && !b.quoteRejection && !error || undefined}>
        {slideReady ? <SlideConfirm key={b.quote!.requestId} label={`Slide to bridge to ${destination.name}`} front={<AssetMark asset={inputCurrency.symbol} size={26} />} back={convertsAsset ? <AssetMark asset={outputCurrency.symbol} size={26} /> : null} onConfirm={runWalletAction} /> : null}
        <button
          type={quoteAction ? "submit" : "button"}
          className={slideReady ? styles.secondary : styles.primary}
          disabled={actionDisabled}
          onClick={quoteAction ? undefined : runWalletAction}
          data-connect={!b.address || undefined}
        >
          {b.address ? <>
            {loading ? <LoaderCircle size={17} className={styles.spinner} aria-hidden /> : null}
            {label}
            {!loading ? <ArrowRight size={17} aria-hidden /> : null}
          </> : <>
            <span className={styles.actionMark}><Wallet size={17} aria-hidden /></span>
            <span>Connect wallet</span>
            <ArrowRight className={styles.actionArrow} size={17} aria-hidden />
          </>}
        </button>
      </div>
    </form>
  );
}

type ExchangeGuideProps = { address: Address | undefined; destinationChainId: BridgeChainId; focusOnMount?: boolean; onBridge: (arrival: ExchangeArrival) => void; onBack: () => void; onConnect: () => void };

function LiveExchangeGuide(props: ExchangeGuideProps) {
  const view = useExchangeWatch(props.address);
  return <ExchangeGuide {...props} view={view} />;
}

/**
 * From an exchange (lib/bridge/exchange.ts): where to withdraw, a read-only watch for the funds to land, then the bridge
 * on that route. Plain props, so the development fixture can show every state without a wallet or a network.
 */
export function ExchangeGuide({ address, destinationChainId, focusOnMount = false, view, onBridge, onBack, onConnect }: ExchangeGuideProps & { view: ExchangeView }) {
  const [copied, setCopied] = useState(false);
  const addressRef = useRef<HTMLElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  // the guide replaces the form in place: bring its top into view and move focus to its title
  useEffect(() => {
    if (!focusOnMount) return;
    backRef.current?.scrollIntoView({ block: "nearest" });
    titleRef.current?.focus({ preventScroll: true });
  }, [focusOnMount]);
  const destination = BRIDGE_CHAINS[destinationChainId].name;
  // nothing is watched without a wallet, whatever the view says
  const arrivals = address ? view.arrivals : [];
  const landed = arrivals.length > 0;
  const firstBridge = arrivals.find((arrival) => exchangeNext(arrival, destinationChainId).kind === "bridge");
  const names = EXCHANGE_NETWORKS.map((id) => BRIDGE_CHAINS[id].name);
  const watched = `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const seconds = EXCHANGE_POLL_MS / 1000;
  const amountOf = (arrival: ExchangeArrival) => `${formatFundAmount(arrival.amount, arrival.decimals)} ${arrival.asset}`;

  async function copy() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // no clipboard here: select the address so it can be copied by hand
      const node = addressRef.current;
      const selection = window.getSelection();
      if (!node || !selection) return;
      const range = document.createRange();
      range.selectNodeContents(node);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  return (
    <div className={styles.guide}>
      <button ref={backRef} type="button" className={styles.guideBack} onClick={onBack}><ArrowLeft size={14} aria-hidden />Back to the bridge</button>
      <h3 ref={titleRef} tabIndex={-1} className={styles.guideTitle}>From an exchange</h3>
      <p className={styles.guideLead}>{destinationChainId === 8453
        ? "Withdraw ETH or USDC from your exchange to this wallet on Base and it is ready to use. Withdrawn to one of the other networks below, it can be bridged to Base after."
        : `Withdraw ETH or USDC from your exchange to this wallet on one of the networks below, then bridge it to ${destination}.`}</p>
      <ol className={styles.steps}>
        <li><span>1</span><div>
          <strong>Use this wallet&apos;s address</strong>
          {address ? <>
            <code ref={addressRef} className={styles.guideAddress}>{address}</code>
            <button type="button" className={styles.guideButton} onClick={() => void copy()}>{copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}{copied ? "Copied" : "Copy address"}</button>
            <span className="sr-only" role="status">{copied ? "Address copied" : ""}</span>
            <small>Paste it as the withdrawal address on the exchange. Some smart wallets work only on some networks, so pick one your wallet supports.</small>
          </> : <>
            <small>Connect a wallet to see the address to withdraw to.</small>
            <button type="button" className={styles.guideButton} onClick={onConnect}><Wallet size={14} aria-hidden />Connect wallet</button>
          </>}
        </div></li>
        <li><span>2</span><div>
          <strong>Withdraw on one of these networks</strong>
          <div className={styles.guideNetworks}>
            {EXCHANGE_NETWORKS.map((id) => <div key={id}>
              <NetworkMark chain={id} />
              <span className={styles.networkCopy}><span className={styles.networkName}>{BRIDGE_CHAINS[id].name}</span><span className={styles.gasCurrency}>{BRIDGE_SEND_ASSETS[id].join(" or ")}</span></span>
              <em className={styles.guideTag} data-ready={id === destinationChainId || undefined}>{id === destinationChainId ? "No bridge needed" : "Then bridge"}</em>
            </div>)}
          </div>
          <small>Pick one your exchange lists for that token. For USDC, choose USDC itself, not USDC.e or another bridged version: the bridge sends only Circle&apos;s USDC. Bridging USDC from there takes a little ETH on that network for gas, so withdraw some ETH there too.</small>
        </div></li>
        <li data-complete={landed}><span>{landed ? <Check size={13} aria-hidden /> : "3"}</span><div>
          <strong>{landed ? "Landed in your wallet" : "Wait for it to land"}</strong>
          <p className={styles.guideStatus} role="status">
            {address && !landed && !view.unreadable ? <LoaderCircle size={13} className={styles.spinner} aria-hidden /> : null}
            <span>{!address ? "Starts once a wallet is connected."
              : view.checking ? "Checking your balances…"
              : view.unreadable ? `Could not read your balances. Trying again every ${seconds} seconds.`
              : landed ? `${arrivals.map((arrival) => `${amountOf(arrival)} on ${BRIDGE_CHAINS[arrival.chainId].name}`).join(", ")}.`
              : `Watching ${watched} every ${seconds} seconds. You can close the panel and reopen it in this tab to keep watching.`}</span>
          </p>
        </div></li>
        <li><span>4</span><div>
          <strong>{destinationChainId === 8453 ? "Bridge it to Base if it landed elsewhere" : `Bridge it to ${destination}`}</strong>
          {!landed ? <small>Once it lands, the bridge opens on that route.</small> : arrivals.map((arrival) => {
            const from = BRIDGE_CHAINS[arrival.chainId].name;
            return <div key={`${arrival.chainId}:${arrival.asset}`} className={styles.guideArrival}>
              {exchangeNext(arrival, destinationChainId).kind === "ready"
                ? <p>{amountOf(arrival)} is on {from}, ready to use. No bridge needed.</p>
                : <>
                  <button type="button" className={arrival === firstBridge ? styles.primary : styles.secondary} onClick={() => onBridge(arrival)}>Bridge {amountOf(arrival)} from {from}<ArrowRight size={17} aria-hidden /></button>
                  {exchangeNeedsGas(arrival) ? <p className={styles.guideGas} role="status"><CircleAlert size={15} aria-hidden /><span>There is no ETH on {from} to pay gas for sending {arrival.asset}. Withdraw a little ETH to {from} as well. This updates when it lands.</span></p> : null}
                </>}
            </div>;
          })}
        </div></li>
      </ol>
      <p className={styles.disclaimer}>The exchange sends to your wallet and sets its own withdrawal fees, limits and timing. This guide only reads your balances. It never asks your wallet for anything, and openlaunch never holds your funds.</p>
    </div>
  );
}

function ApprovalProgress({ bridge: b }: { bridge: Bridge }) {
  const approval = b.approval!;
  const approvalChain = BRIDGE_CHAINS[approval.chainId];
  // the chain's one ERC-20: USDC on Base and Arc, USDG on Robinhood Chain
  const approvalSymbol = bridgeTokenAsset(approval.chainId) ?? "token";
  const uncertain = approval.status === "uncertain";
  const health = b.approvalHealth;
  const needsAttention = uncertain || (!!health && health.kind !== "waiting");
  const [hash, setHash] = useState("");
  const [verifying, setVerifying] = useState(false);
  const mode = needsAttention ? "attention" : "approval";
  return <div className={`${styles.transfer} ${dotFont.variable}`}>
    <SignalBoard from={approval.chainId} to={null} mode={mode} caption={signalCaption(mode, approvalChain.name)} />
    <div className={styles.transferRoute}><NetworkMark chain={approval.chainId} /><span>{approvalSymbol} approval on {approvalChain.name}</span></div>
    <div className={styles.statusHeading} role="status">
      <span className={styles.statusIcon}>{needsAttention ? <CircleAlert size={26} aria-hidden /> : <LoaderCircle size={26} className={styles.spinner} aria-hidden />}</span>
      <h3>{verifying ? "Verifying transaction" : b.approvalBusy ? "Check your wallet" : uncertain ? "Check your approval" : health?.title ?? "Approval submitted"}</h3>
      <p>{verifying ? `Checking the transaction on ${approvalChain.name}. No wallet request will be made.` : b.approvalBusy ? `Approve the exact ${approvalSymbol} amount in your wallet. This is not the bridge deposit.` : uncertain ? "The wallet response was interrupted. Check your wallet’s activity and verify the transaction hash below. Do not approve again." : health?.detail ?? `Waiting for ${approvalChain.name} to confirm. You’ll review a fresh bridge quote next.`}</p>
    </div>
    <dl className={styles.transferDetails}><div><dt>Approval limit</dt><dd>{nativeAmount(formatUnits(BigInt(approval.amount), 6))} {approvalSymbol}</dd></div></dl>
    {b.address ? <Recipient address={b.address} /> : null}
    <p className={styles.approvalNotice}>No bridge deposit has been requested. An approval permits {approval.spender.toLowerCase() === CCTP_APPROVAL_SPENDER ? "Circle’s transfer contract" : "Relay’s deposit contract"} to use up to this amount; it does not bridge it.</p>
    {b.approvalError || b.storageError ? <p className={styles.error} role="alert"><CircleAlert size={16} aria-hidden /><span>{b.approvalError || b.storageError}</span></p> : null}
    {approval.approvalHash ? <a className={styles.externalAction} href={`${approvalChain.explorer}/tx/${approval.approvalHash}`} target="_blank" rel="noreferrer">View approval on {approvalChain.name} <ArrowUpRight size={17} aria-hidden /></a> : null}
    {!b.approvalBusy ? <details className={styles.approvalRecovery}>
      <summary>{approval.approvalHash ? "Sped up your approval in the wallet?" : "Have the approval transaction hash?"}</summary>
      <p>Copy the confirmed approval hash from your wallet’s activity on {approvalChain.name}. We’ll verify the network, wallet, token, spender, exact amount and confirmation before resuming. A cancellation or an unrelated transaction cannot be used.</p>
      <form onSubmit={(event) => { event.preventDefault(); setVerifying(true); void b.recoverApproval(hash.trim()).finally(() => setVerifying(false)); }}>
        <label htmlFor="bridge-approval-hash" className={styles.smallLabel}>Approval transaction hash</label>
        <input id="bridge-approval-hash" value={hash} onChange={(event) => setHash(event.target.value)} placeholder="0x…" maxLength={66} autoComplete="off" spellCheck={false} />
        <button type="submit" className={styles.newTransfer} disabled={verifying || !/^0x[0-9a-fA-F]{64}$/.test(hash.trim())}>Verify approval transaction</button>
      </form>
    </details> : null}
    {approval.approvalHash ? <button type="button" className={styles.newTransfer} disabled={b.approvalBusy} onClick={b.retryApproval}>Check approval status</button> : null}
    {b.approvalCanBeDiscarded ? <details className={styles.approvalRecovery}>
      <summary>Still not confirmed after {DISCARD_AFTER_MS / 60_000} minutes?</summary>
      <p>No confirmation was found for this saved approval hash. This does not prove the transaction was dropped. Check your wallet’s earliest pending transaction before starting over; discarding this record does not cancel it or fix a queued nonce. If it confirms later it only grants this exact allowance; the next deposit re-checks it.</p>
      <button type="button" className={styles.newTransfer} disabled={b.approvalBusy || b.discarding} onClick={b.discardApproval}>{b.discarding ? "Checking the approval…" : "Discard this approval"}</button>
    </details> : null}
    <p className={styles.disclaimer}>You can close this panel. Reopen Bridge with this wallet to resume. If you stop after approval, the unspent allowance remains until used or revoked.</p>
  </div>;
}

export function Transfer({ bridge: b }: { bridge: Bridge }) {
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
  const circle = transfer.provider === "cctp";
  const provider = bridgeProviderName(transfer.provider);
  const title = success ? `Arrived on ${destination.name}` : refund ? `${provider} reports a refund` : reverted ? "The deposit reverted" : failed ? "Transfer needs attention" : uncertain ? "Checking your transfer" : waitingForWallet ? "Check your wallet" : "Your transfer is on its way";
  const detail = success ? `${provider} has confirmed ${outputCurrency.symbol} delivery to your receiving wallet.` : refund ? `Check your wallets on both networks and ${provider}’s transfer details before trying again.` : reverted ? `The source network rejected the deposit. Your ${inputCurrency.symbol} was not bridged; network gas was still charged.` : failed ? `${provider} couldn’t complete this transfer. Check the transfer details for recovery before sending again.` : uncertain ? "The wallet response was interrupted. Don’t send again while we check whether your deposit was submitted." : waitingForWallet ? "Review the network, amount and transaction in your wallet. Nothing moves without your confirmation." : "You can close this panel. Reopen Bridge with this wallet to check its status.";

  const mode = signalMode({ phase: b.phase, tracked: true, approvalActive: false, quoteLoading: false, reviewing: false, quoteExpired: false, blocked: false });

  return (
    <div className={`${styles.transfer} ${dotFont.variable}`}>
      <SignalBoard from={transfer.originChainId} to={transfer.destinationChainId} mode={mode} caption={signalCaption(mode, destination.name)} />
      <div className={styles.transferRoute}><NetworkMark chain={transfer.originChainId} /><span>{origin.name}</span><ArrowRight size={16} aria-hidden /><NetworkMark chain={transfer.destinationChainId} /><span>{destination.name}</span></div>
      <div className={styles.statusHeading} role="status">
        <span className={`${styles.statusIcon} ${success ? styles.success : ""}`}>{success ? <Check size={26} aria-hidden /> : terminal || uncertain ? <CircleAlert size={26} aria-hidden /> : <LoaderCircle size={26} className={styles.spinner} aria-hidden />}</span>
        <h3>{title}</h3><p>{detail}</p>
      </div>
      <dl className={styles.transferDetails}>
        <div><dt>Amount sent</dt><dd className={styles.transferAmount}><AssetMark asset={inputCurrency.symbol} size={20} />{nativeAmount(formatUnits(BigInt(transfer.amount), inputCurrency.decimals))} {inputCurrency.symbol}</dd></div>
      </dl>
      <Recipient address={transfer.address} />
      <ol className={styles.steps} aria-label="Transfer progress">
        <li data-complete={!reverted && (!!transfer.sourceHash || success || refund)}><span>{!reverted && (transfer.sourceHash || success || refund) ? <Check size={13} aria-hidden /> : "1"}</span><div><strong>Deposit on {origin.name}</strong><small>{reverted ? "Reverted. Deposit not made." : transfer.sourceHash || success || refund ? "Submitted to the source network" : waitingForWallet ? "Awaiting wallet confirmation" : "Checking for your deposit"}</small></div></li>
        <li data-complete={success}><span>{success ? <Check size={13} aria-hidden /> : "2"}</span><div><strong>{refund ? `Refund reported by ${provider}` : circle ? `Circle mints on ${destination.name}` : "Relay processes the transfer"}</strong><small>{transfer.status === "delayed" ? "Taking longer than expected. Tracking continues." : failed ? "Open transfer details for help" : success ? "Transfer complete" : "Live status from the bridge provider"}</small></div></li>
        <li data-complete={success}><span>{success ? <Check size={13} aria-hidden /> : "3"}</span><div><strong>Receive {outputCurrency.symbol} on {destination.name}</strong><small>{success ? "Delivered to the same wallet address" : "Delivery will be confirmed here"}</small></div></li>
      </ol>
      {b.error || b.statusError || b.storageError ? <p className={styles.error} role="alert"><CircleAlert size={16} aria-hidden /><span>{b.error || b.statusError || b.storageError}{b.statusError ? <button type="button" className={styles.inlineButton} onClick={b.retryStatus}>Check again</button> : null}</span></p> : null}
      {circle ? null : <a className={styles.externalAction} href={`https://relay.link/transaction/${transfer.requestId}`} target="_blank" rel="noreferrer">View transfer on Relay<ArrowUpRight size={17} aria-hidden /></a>}
      <div className={styles.explorerLinks}>
        {transfer.sourceHash ? <a href={`${origin.explorer}/tx/${transfer.sourceHash}`} target="_blank" rel="noreferrer">Source transaction <ArrowUpRight size={12} aria-hidden /></a> : null}
        {success && transfer.destinationHashes[0] ? <a href={`${destination.explorer}/tx/${transfer.destinationHashes[0]}`} target="_blank" rel="noreferrer">Destination transaction <ArrowUpRight size={12} aria-hidden /></a> : null}
      </div>
      {b.canReset ? <button type="button" className={styles.newTransfer} onClick={b.reset}>New bridge<ChevronRight size={15} aria-hidden /></button> : null}
      {b.canDiscard ? <details className={styles.approvalRecovery}>
        <summary>No deposit after {DISCARD_AFTER_MS / 60_000} minutes?</summary>
        <p>{provider} has not seen a deposit for this transfer and nothing is confirmed on {origin.name}. If your wallet shows the transaction as dropped or cancelled, you can discard this record and start over.{circle ? "" : " Keep the Transfer ID below in case you need Relay support."}</p>
        <button type="button" className={styles.newTransfer} disabled={b.discarding} onClick={b.discard}>{b.discarding ? "Checking the transfer…" : "Discard this transfer"}</button>
      </details> : null}
      {circle ? null : <p className={styles.disclaimer}>Transfer ID <span className={styles.requestId}>{transfer.requestId}</span></p>}
    </div>
  );
}
