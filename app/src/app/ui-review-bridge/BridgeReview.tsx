"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Select } from "@base-ui/react/select";
import { ArrowDown, ArrowUpRight, Check, ChevronDown, PanelsTopLeft } from "lucide-react";
import BridgePageLayout from "@/app/bridge/BridgePageLayout";
import { BridgeFooter, BridgeForm, BridgeModal, ExchangeGuide, Transfer } from "@/components/bridge/BridgeDialog";
import { EXCHANGE_IDLE, type ExchangeView } from "@/components/bridge/useExchangeWatch";
import type useBridge from "@/components/bridge/useBridge";
import { formatUnits, parseEther, parseUnits, zeroAddress } from "viem";
import { canReverseBridgeRoute, changeBridgeRoute, parseBridgeAmount, type BridgeRouteChange, type BridgeRouteInputs } from "@/lib/bridge/client";
import { bridgeCurrency, bridgeFeePercent, defaultBridgeAsset, type BridgeQuote } from "@/lib/bridge/types";
import type { TrackedApproval } from "@/lib/bridge/approval";
import { describePendingApproval } from "@/lib/bridge/approval-health";
import { BRIDGE_QUOTE_DEBOUNCE_MS } from "@/lib/bridge/quote-session";
import signal from "@/components/bridge/Signal.module.css";
import shell from "@/components/sections/SectionShell.module.css";
import { HistoryBoard } from "@/components/bridge/BridgeHistory";
import type { BridgeHistoryEntry } from "@/lib/bridge/history";
import { FundCard } from "@/components/bridge/BridgeToBuy";
import type { BridgeHolding, FundStep } from "@/lib/bridge/fund";
import type { BridgeAsset, BridgeChainId, BridgeDestinationId } from "@/lib/bridge/types";
import { CCTP_TOKEN_MESSENGER, cctpRoute } from "@/lib/bridge/cctp";
import styles from "./review.module.css";

const wallet = "0x03508bB71268BBA25ECaCC8F620e01866650532c" as const;
const RELAY = "0x4cd00e387622c35bddb9b4c962c136462338bc31" as const;
const requestId = `0x${"1".repeat(64)}` as const;
const SCENE_LABELS = {
  disconnected: "Wallet disconnected",
  idle: "Enter an amount",
  quoting: "Fetching a quote",
  quote: "Review a quote",
  high_fee: "High bridge fee",
  fee_boundary: "Fee just over the limit",
  impact_limit: "Conversion loss over the limit",
  expired: "Quote expired",
  error: "Quote unavailable",
  approval_pending: "Approval submitted",
  approval_uncertain: "Approval status unknown",
  approval_confirmed: "Approval confirmed",
  approval_queued: "Approval queued",
  approval_missing: "Approval missing",
  approval_fee: "Approval gas fee too low",
  pending: "Transfer in progress",
  success: "Transfer arrived",
  uncertain: "Transfer status unknown",
  refund: "Transfer refunded",
} as const;
type Scene = keyof typeof SCENE_LABELS;
const DEFAULT_ROUTE: BridgeRouteInputs = { originChainId: 8453, destinationChainId: 5042, originAsset: "USDC", destinationAsset: "USDC", amount: "25" };

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const minutesAgo = (minutes: number) => Date.UTC(2026, 10, 10, 12, 0) - minutes * 60_000;
// One row per thing the board can say, on real routes and in real units.
const HISTORY_ROWS: BridgeHistoryEntry[] = [
  { requestId: hash(11), originChainId: 8453, destinationChainId: 4663, originAsset: "ETH", destinationAsset: "ETH", amountIn: "20000000000000000", inDecimals: 18, amountOut: "19962000000000000", outDecimals: 18, outKind: "quoted", status: "pending", reverted: false, createdAt: minutesAgo(1), sourceHash: hash(12), destinationHashes: [], recipient: null },
  { requestId: hash(21), originChainId: 42161, destinationChainId: 8453, originAsset: "USDC", destinationAsset: "USDC", amountIn: "25000000", inDecimals: 6, amountOut: "24975000", outDecimals: 6, outKind: "received", status: "success", reverted: false, createdAt: minutesAgo(48), sourceHash: hash(22), destinationHashes: [hash(23)], recipient: null },
  { requestId: hash(31), originChainId: 8453, destinationChainId: 4663, originAsset: "USDC", destinationAsset: "USDG", amountIn: "150000000", inDecimals: 6, amountOut: "149810000", outDecimals: 6, outKind: "received", status: "success", reverted: false, createdAt: minutesAgo(60 * 5), sourceHash: hash(32), destinationHashes: [hash(33)], recipient: null },
  { requestId: hash(41), originChainId: 8453, destinationChainId: 5042, originAsset: "USDC", destinationAsset: "USDC", amountIn: "60000000", inDecimals: 6, amountOut: "59940000000000000000", outDecimals: 18, outKind: "quoted", status: "delayed", reverted: false, createdAt: minutesAgo(60 * 9), sourceHash: hash(42), destinationHashes: [], recipient: null },
  { requestId: hash(51), originChainId: 1, destinationChainId: 5042, originAsset: "ETH", destinationAsset: "USDC", amountIn: "50000000000000000", inDecimals: 18, amountOut: "155300000000000000000", outDecimals: 18, outKind: "quoted", status: "refund", reverted: false, createdAt: minutesAgo(60 * 26), sourceHash: hash(52), destinationHashes: [], recipient: null },
  { requestId: hash(91), originChainId: 99901, destinationChainId: 8453, originAsset: "USDC", destinationAsset: "USDC", amountIn: "25000000", inDecimals: 6, amountOut: "24664192", outDecimals: 6, outKind: "received", status: "success", reverted: false, createdAt: minutesAgo(60 * 30), sourceHash: hash(92), destinationHashes: [hash(93)], recipient: null },
  { requestId: hash(95), originChainId: 8453, destinationChainId: 99901, originAsset: "USDC", destinationAsset: "HYPE", amountIn: "25000000", inDecimals: 6, amountOut: "343478554577755790", outDecimals: 18, outKind: "received", status: "success", reverted: false, createdAt: minutesAgo(60 * 40), sourceHash: hash(96), destinationHashes: [hash(97)], recipient: null },
  { requestId: hash(61), originChainId: 10, destinationChainId: 8453, originAsset: "ETH", destinationAsset: "ETH", amountIn: "8000000000000000", inDecimals: 18, amountOut: null, outDecimals: 18, outKind: null, status: "failure", reverted: true, createdAt: minutesAgo(60 * 50), sourceHash: hash(62), destinationHashes: [], recipient: null },
  { requestId: hash(71), originChainId: 4663, destinationChainId: 8453, originAsset: "ETH", destinationAsset: "ETH", amountIn: "4000000000000000", inDecimals: 18, amountOut: "3991000000000000", outDecimals: 18, outKind: "received", status: "success", reverted: false, createdAt: minutesAgo(60 * 80), sourceHash: hash(72), destinationHashes: [hash(73)], recipient: "0x9f3a2bE0c1D4e5F6a7b8C9d0E1f2A3b4C5d6E7F8" },
  { provider: "cctp", requestId: hash(81), originChainId: 42161, destinationChainId: 5042, originAsset: "USDC", destinationAsset: "USDC", amountIn: "40000000", inDecimals: 6, amountOut: "39983361000000000000", outDecimals: 18, outKind: "received", status: "success", reverted: false, createdAt: minutesAgo(60 * 96), sourceHash: hash(82), destinationHashes: [hash(83)], recipient: null },
];
const HISTORY_LABELS = { rows: "Sample transfers", empty: "No transfers yet", loading: "Loading", "no wallet": "Wallet disconnected", unsaved: "Storage unavailable" } as const;
type HistoryScene = keyof typeof HISTORY_LABELS;
const PROVIDER_LABELS = { relay: "Relay", circle: "Circle CCTP" } as const;

// "Bridge, then buy" in the trade panel, one card per step it can show.
type FundScene = { name: string; step: FundStep; destination: BridgeDestinationId; asset: BridgeAsset; symbol: string; row: BridgeHistoryEntry | null; shortBy: string | null; suggestion: BridgeHolding | null; searching: boolean };
const FUND_SCENES: FundScene[] = [
  { name: "short, source found", step: "short", destination: 4663, asset: "ETH", symbol: "ORBIT", row: null, shortBy: "0.0125 ETH", suggestion: { chainId: 8453, asset: "USDC", amount: 120_500_000n, decimals: 6 }, searching: false },
  { name: "short, checking", step: "short", destination: 4663, asset: "ETH", symbol: "ORBIT", row: null, shortBy: "0.0125 ETH", suggestion: null, searching: true },
  { name: "empty, nothing elsewhere", step: "short", destination: 5042, asset: "USDC", symbol: "ARCO", row: null, shortBy: null, suggestion: null, searching: false },
  { name: "moving", step: "moving", destination: 4663, asset: "ETH", symbol: "ORBIT", row: { ...HISTORY_ROWS[0], originChainId: 42161, createdAt: minutesAgo(1) }, shortBy: null, suggestion: null, searching: false },
  { name: "delayed", step: "moving", destination: 5042, asset: "USDC", symbol: "ARCO", row: HISTORY_ROWS[3], shortBy: null, suggestion: null, searching: false },
  { name: "arrived", step: "arrived", destination: 8453, asset: "USDC", symbol: "BASED", row: HISTORY_ROWS[1], shortBy: null, suggestion: null, searching: false },
  { name: "refunded", step: "attention", destination: 5042, asset: "USDC", symbol: "ARCO", row: HISTORY_ROWS[4], shortBy: null, suggestion: null, searching: false },
  { name: "Elysium, source found", step: "short", destination: 99901, asset: "USDC", symbol: "KINO", row: null, shortBy: "18.5 USDC", suggestion: { chainId: 42161, asset: "USDC", amount: 64_200_000n, decimals: 6 }, searching: false },
  { name: "Elysium HYPE, source found", step: "short", destination: 99901, asset: "HYPE", symbol: "KINO", row: null, shortBy: "0.25 HYPE", suggestion: { chainId: 8453, asset: "ETH", amount: 40_000_000_000_000_000n, decimals: 18 }, searching: false },
  { name: "Elysium HYPE, arrived", step: "arrived", destination: 99901, asset: "HYPE", symbol: "KINO", row: HISTORY_ROWS[6], shortBy: null, suggestion: null, searching: false },
];

// "From an exchange", one guide per state it can show. Arrivals are synthetic, in real units.
type ExchangeScene = { name: string; address: typeof wallet | undefined; destinationChainId: BridgeChainId; view: ExchangeView };
const watching: ExchangeView = { checking: false, unreadable: false, arrivals: [] };
const EXCHANGE_SCENES: ExchangeScene[] = [
  { name: "no wallet", address: undefined, destinationChainId: 4663, view: EXCHANGE_IDLE },
  { name: "watching", address: wallet, destinationChainId: 4663, view: watching },
  { name: "balances unreadable", address: wallet, destinationChainId: 4663, view: { ...watching, unreadable: true } },
  { name: "USDC landed, no gas", address: wallet, destinationChainId: 5042, view: { ...watching, arrivals: [{ chainId: 42161, asset: "USDC", amount: 250_000_000n, decimals: 6, gas: 0n }] } },
  { name: "USDC and ETH landed", address: wallet, destinationChainId: 99901, view: { ...watching, arrivals: [{ chainId: 42161, asset: "USDC", amount: 250_000_000n, decimals: 6, gas: 4_000_000_000_000_000n }, { chainId: 42161, asset: "ETH", amount: 4_000_000_000_000_000n, decimals: 18, gas: null }] } },
  { name: "landed on Base, wanted on Base", address: wallet, destinationChainId: 8453, view: { ...watching, arrivals: [{ chainId: 8453, asset: "USDC", amount: 100_000_000n, decimals: 6, gas: 2_000_000_000_000_000n }] } },
];
// the dialog's guide: 25 USDC on Arbitrum with no ETH beside it, so its button opens the bridge on that route
const DIALOG_EXCHANGE: ExchangeView = { ...watching, arrivals: [{ chainId: 42161, asset: "USDC", amount: 25_000_000n, decimals: 6, gas: 0n }] };

function ReviewSelect<Value extends string>({ label, options, value, onChange }: { label: string; options: Record<Value, string>; value: Value; onChange: (value: Value) => void }) {
  const items = (Object.keys(options) as Value[]).map((key) => ({ value: key, label: options[key] }));
  return (
    <Select.Root items={items} value={value} onValueChange={(next) => { if (next !== null) onChange(next); }}>
      <div className={styles.field}>
        <Select.Label className={styles.label}>{label}</Select.Label>
        <Select.Trigger type="button" className={styles.select}>
          <Select.Value /><Select.Icon><ChevronDown size={14} aria-hidden /></Select.Icon>
        </Select.Trigger>
      </div>
      <Select.Portal>
        <Select.Positioner className={styles.positioner} sideOffset={6} collisionPadding={12} alignItemWithTrigger={false}>
          <Select.Popup className={styles.menu}>
            <Select.List>
              {items.map((item) => (
                <Select.Item key={item.value} value={item.value} label={item.label} className={styles.option}>
                  <Select.ItemText>{item.label}</Select.ItemText>
                  <Select.ItemIndicator><Check size={14} aria-hidden /></Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

export default function BridgeReview() {
  const [historyScene, setHistoryScene] = useState<HistoryScene>("rows");
  const [open, setOpen] = useState(false);
  const [scene, setScene] = useState<Scene>("disconnected");
  const [route, setRoute] = useState<BridgeRouteInputs>(DEFAULT_ROUTE);
  const [approved, setApproved] = useState(false);
  // Which provider the synthetic quote comes from. Circle only carries USDC to USDC into Base or Arc.
  const [circle, setCircle] = useState(false);
  const { originChainId: origin, destinationChainId: destination, amount } = route;
  const originAsset = route.originAsset ?? defaultBridgeAsset(origin);
  const destinationAsset = route.destinationAsset ?? defaultBridgeAsset(destination);
  const inputCurrency = bridgeCurrency(origin, originAsset, "input");
  const outputCurrency = bridgeCurrency(destination, destinationAsset, "output");
  const erc20Input = inputCurrency.address !== zeroAddress;
  const viaCircle = circle && cctpRoute({ ...route, originAsset, destinationAsset }) !== null;
  const changeRoute = (change: BridgeRouteChange) => { setRoute((current) => changeBridgeRoute(current, change)); setApproved(false); setScene((current) => current === "disconnected" ? current : "idle"); };
  const setAmount = (value: string) => { setRoute((current) => ({ ...current, amount: value })); setApproved(false); setScene((current) => current === "disconnected" ? current : "idle"); };
  const [clock] = useState(() => Date.now());
  // Synthetic fixed conversion, not a market quote. This page never calls Relay.
  const inputAmount = parseBridgeAmount(amount, inputCurrency.decimals) ?? 0n;
  useEffect(() => {
    if ((scene !== "idle" && scene !== "approval_confirmed") || !inputAmount) return;
    const timer = setTimeout(() => setScene("quote"), BRIDGE_QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [scene, inputAmount, amount, origin, destination, originAsset, destinationAsset]);
  const normalizedInput = inputAmount * 10n ** BigInt(18 - inputCurrency.decimals);
  const netAmount = normalizedInput * 9975n / 10000n;
  // fixed synthetic dollar prices, not market data
  const PRICE: Record<BridgeAsset, bigint> = { ETH: 2400n, USDC: 1n, USDG: 1n, HYPE: 72n };
  const converted = originAsset === destinationAsset ? netAmount : netAmount * PRICE[originAsset] / PRICE[destinationAsset];
  // Circle: one synthetic fixed fee (the size of the live Fast plus forward fee), delivered exactly
  const circleFee = destination === 5042 ? 16_577n : 54_447n;
  const outputAmount = viaCircle ? (inputAmount > circleFee ? inputAmount - circleFee : 0n) * 10n ** BigInt(outputCurrency.decimals - 6) : converted / 10n ** BigInt(18 - outputCurrency.decimals);
  const quote: BridgeQuote = {
    address: wallet, originChainId: origin, destinationChainId: destination, originAsset, destinationAsset, amount: inputAmount.toString(),
    requestId, amountOut: outputAmount.toString(), minimumAmountOut: (viaCircle ? outputAmount : outputAmount * 995n / 1000n).toString(), relayFee: formatUnits(viaCircle ? circleFee : inputAmount * 25n / 10000n, inputCurrency.decimals), sourceGas: origin === 5042 ? "0.001" : "0.0000007", totalImpactPercent: viaCircle && inputAmount > 0n ? `-${bridgeFeePercent(circleFee, inputAmount)}` : "-0.25", timeEstimate: viaCircle ? (origin === 5042 ? 15 : 25) : 2, expiresAt: clock + 45_000, ttlMs: 45_000,
    ...(viaCircle ? { provider: "cctp" as const } : {}),
    transaction: { to: wallet, data: "0x", value: "0", chainId: origin }, // deliberately non-executable fixture
    ...(erc20Input ? { approval: { token: inputCurrency.address, spender: viaCircle ? CCTP_TOKEN_MESSENGER : RELAY, amount: inputAmount.toString() } } : {}),
  };
  const approval: TrackedApproval | null = erc20Input && (origin === 5042 || origin === 8453 || origin === 99901) && (scene.startsWith("approval_") || approved) ? { version: 1, chainId: origin, address: wallet, token: inputCurrency.address, spender: viaCircle ? CCTP_TOKEN_MESSENGER.toLowerCase() as typeof RELAY : RELAY, amount: inputAmount.toString(), createdAt: clock, status: scene === "approval_uncertain" ? "uncertain" : scene === "approval_confirmed" || approved ? "confirmed" : "pending", ...(scene === "approval_uncertain" ? {} : { approvalHash: requestId }) } : null;
  const tracking = ["pending", "success", "uncertain", "refund"].includes(scene);
  const feeWarning = ["high_fee", "fee_boundary", "impact_limit"].includes(scene);
  const rejectedFee = scene === "fee_boundary" ? inputAmount / 20n + 1n : scene === "impact_limit" ? inputAmount / 400n : inputAmount * 55548n / 1_000_000n;
  const bridge: ReturnType<typeof useBridge> = {
    address: scene === "disconnected" ? undefined : wallet, walletChainId: origin,
    originChainId: origin, destinationChainId: destination, setOriginChainId: (chainId) => changeRoute({ side: "origin", chainId }), setDestinationChainId: (chainId) => changeRoute({ side: "destination", chainId }), reverseRoute: () => changeRoute({ side: "reverse" }), canReverse: canReverseBridgeRoute({ originChainId: origin }), amount, setAmount,
    originAsset, destinationAsset, setOriginAsset: (asset) => changeRoute({ side: "origin-asset", asset }), setDestinationAsset: (asset) => changeRoute({ side: "destination-asset", asset }),
    balance: parseUnits(originAsset === "ETH" ? "0.05" : "125", inputCurrency.decimals), nativeBalance: parseEther(origin === 5042 ? "125" : "0.05"), balanceLoading: false, balanceError: null,
    quote: scene === "quote" || scene === "expired" ? quote : null,
    phase: tracking ? scene as "pending" | "success" | "uncertain" | "refund" : scene === "quote" || scene === "expired" ? "review" : "idle",
    error: null, quoteError: scene === "error" ? "Relay is temporarily unavailable. Try requesting a quote again." : feeWarning ? "This quote exceeds the 5% safety limit." : null,
    quoteRejection: feeWarning && inputAmount > 0n ? { address: wallet, originChainId: origin, destinationChainId: destination, originAsset, destinationAsset, amount: inputAmount.toString(), reason: scene === "impact_limit" ? "total-impact" : "relay-fee", relayFee: formatUnits(rejectedFee, inputCurrency.decimals), relayFeePercent: bridgeFeePercent(rejectedFee, inputAmount), sourceGas: quote.sourceGas, totalImpactPercent: scene === "impact_limit" ? "-5.000000000000000001" : "-5.5548" } : null,
    quoteLoading: scene === "quoting" || (scene === "idle" || scene === "approval_confirmed") && inputAmount > 0n, canQuote: inputAmount > 0n,
    quoteExpired: scene === "expired", requestQuote: async () => setScene("quote"), confirm: async () => setScene("pending"), reset: () => setScene("quote"),
    tracked: tracking ? { ...(viaCircle ? { provider: "cctp" as const } : {}), address: wallet, requestId, amount: quote.amount, originChainId: origin, destinationChainId: destination, originAsset, destinationAsset, destinationHashes: [], status: scene as "pending" | "success" | "uncertain" | "refund", createdAt: clock } : null,
    statusError: null, retryStatus: () => {}, storageError: null, busy: false, canReset: scene === "success" || scene === "refund",
    approval, approvalRequired: erc20Input && !approved, allowanceLoading: false, approvalBusy: false, approvalError: null,
    approvalHealth: ["approval_queued", "approval_missing", "approval_fee"].includes(scene) ? describePendingApproval({ createdAt: clock - 70_000, now: clock, transaction: scene === "approval_missing" ? null : { nonce: 2, maxFeePerGas: 30_000_000_000n }, latestNonce: scene === "approval_queued" ? 0 : 2, baseFeePerGas: 166_000_000_000n }) : null,
    approve: async () => setScene("approval_pending"), retryApproval: () => { setApproved(true); setScene("approval_confirmed"); },
    recoverApproval: async () => { setApproved(true); setScene("approval_confirmed"); },
    approvalCanBeDiscarded: scene === "approval_uncertain", discardApproval: async () => { setApproved(false); setScene("idle"); },
    canDiscard: scene === "uncertain", discard: async () => setScene("idle"), discarding: false,
  };

  function selectScene(value: Scene) {
    if (value === "idle") {
      setRoute((current) => ({ ...current, amount: "" }));
    } else if (value.startsWith("approval_") && (!erc20Input || (origin !== 5042 && origin !== 8453 && origin !== 99901))) {
      setRoute(DEFAULT_ROUTE);
    } else if (!inputAmount) {
      setRoute((current) => ({ ...current, amount: originAsset === "ETH" ? "0.01" : "25" }));
    }
    setApproved(value === "approval_confirmed");
    setScene(value);
  }

  function selectProvider(value: keyof typeof PROVIDER_LABELS) {
    const useCircle = value === "circle";
    if (useCircle && !cctpRoute({ ...route, originAsset, destinationAsset })) setRoute(DEFAULT_ROUTE);
    setCircle(useCircle);
    setApproved(false);
  }

  const content = tracking ? <Transfer bridge={bridge} /> : <BridgeForm bridge={bridge} connect={() => selectScene("quote")} idPrefix="bridge-preview" exchangeView={DIALOG_EXCHANGE} />;
  const footerUsesCircle = (bridge.tracked?.provider ?? bridge.quote?.provider) === "cctp";
  return (
    <>
      <BridgePageLayout
        introActions={<>
          <a href="#trade-previews" className={shell.textLink}>Trade panel <ArrowDown size={14} aria-hidden /></a>
          <Link href="/bridge" className={shell.textLink}>Live bridge <ArrowUpRight size={14} aria-hidden /></Link>
        </>}
        controls={
          <section className={styles.toolbar} aria-labelledby="bridge-preview-heading">
            <div className={styles.toolbarCopy}>
              <h2 id="bridge-preview-heading">Development preview</h2>
              <p>Sample data. No wallet requests, API calls, or funds.</p>
            </div>
            <div className={styles.toolbarActions}>
              <ReviewSelect label="Bridge state" options={SCENE_LABELS} value={scene} onChange={selectScene} />
              <ReviewSelect label="Quote provider" options={PROVIDER_LABELS} value={viaCircle ? "circle" : "relay"} onChange={selectProvider} />
              <button type="button" className={shell.action} onClick={() => setOpen(true)}><PanelsTopLeft size={15} aria-hidden />Open dialog</button>
            </div>
          </section>
        }
        panel={
          <section className={signal.pagePanel} aria-label="Bridge">
            {open ? <p className={styles.dialogNotice}>The bridge preview is open in a dialog.</p> : content}
            <BridgeFooter circle={footerUsesCircle} hideHistory />
          </section>
        }
        history={<>
          <div className={styles.historyPreview}>
            <ReviewSelect label="Transfer history state" options={HISTORY_LABELS} value={historyScene} onChange={setHistoryScene} />
            <HistoryBoard wallet={historyScene === "no wallet" ? "" : wallet.toLowerCase()} rows={historyScene === "rows" || historyScene === "unsaved" ? HISTORY_ROWS : []} loading={historyScene === "loading"} unsaved={historyScene === "unsaved"} note="Preview only. Sample transfers for this browser session." onRefresh={() => {}} />
          </div>
          <section id="trade-previews" className={styles.trade} aria-labelledby="trade-preview-heading">
            <h2 id="trade-preview-heading">Bridge, then buy</h2>
            <p>Preview how the funding card looks inside the token trade panel.</p>
            <div className={styles.tradeGrid}>
              {FUND_SCENES.map(({ name, ...fixture }) => (
                <figure key={name}>
                  <figcaption>{name}</figcaption>
                  <FundCard {...fixture} onBridge={() => {}} onOpen={() => {}} onDismiss={() => {}} />
                </figure>
              ))}
            </div>
          </section>
          <section className={styles.trade} aria-labelledby="exchange-preview-heading">
            <h2 id="exchange-preview-heading">From an exchange</h2>
            <p>Each state of the bridge panel&apos;s exchange guide. No balances are read here and its buttons do nothing.</p>
            <div className={`${styles.tradeGrid} ${styles.guideGrid}`}>
              {EXCHANGE_SCENES.map(({ name, ...fixture }) => (
                <figure key={name}>
                  <figcaption>{name}</figcaption>
                  <div className={signal.pagePanel}><ExchangeGuide {...fixture} onBridge={() => {}} onBack={() => {}} onConnect={() => {}} /></div>
                </figure>
              ))}
            </div>
          </section>
        </>}
      />
      <BridgeModal
        open={open}
        onOpenChange={setOpen}
        closeLabel="Close preview"
        description="Development preview. No funds move."
        footer={<BridgeFooter circle={footerUsesCircle} historyHref="#transfers" onHistory={() => setOpen(false)} />}
      >
        {open ? content : null}
      </BridgeModal>
    </>
  );
}
