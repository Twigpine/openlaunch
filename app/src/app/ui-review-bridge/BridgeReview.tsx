"use client";

import { useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { BridgeForm, Transfer } from "@/components/bridge/BridgeDialog";
import type useBridge from "@/components/bridge/useBridge";
import { formatUnits, parseEther, parseUnits, zeroAddress } from "viem";
import { canReverseBridgeRoute, changeBridgeRoute, parseBridgeAmount, type BridgeRouteChange, type BridgeRouteInputs } from "@/lib/bridge/client";
import { bridgeCurrency, bridgeFeePercent, defaultBridgeAsset, type BridgeQuote } from "@/lib/bridge/types";
import type { TrackedApproval } from "@/lib/bridge/approval";
import { describePendingApproval } from "@/lib/bridge/approval-health";
import { BRIDGE_QUOTE_DEBOUNCE_MS } from "@/lib/bridge/quote-session";
import styles from "@/components/bridge/BridgeDialog.module.css";
import { HistoryBoard } from "@/components/bridge/BridgeHistory";
import type { BridgeHistoryEntry } from "@/lib/bridge/history";
import { FundCard } from "@/components/bridge/BridgeToBuy";
import type { BridgeHolding, FundStep } from "@/lib/bridge/fund";
import type { BridgeAsset, BridgeDestinationId } from "@/lib/bridge/types";
import { CCTP_TOKEN_MESSENGER, cctpRoute } from "@/lib/bridge/cctp";

const wallet = "0x03508bB71268BBA25ECaCC8F620e01866650532c" as const;
const RELAY = "0x4cd00e387622c35bddb9b4c962c136462338bc31" as const;
const requestId = `0x${"1".repeat(64)}` as const;
type Scene = "idle" | "disconnected" | "quote" | "quoting" | "high_fee" | "fee_boundary" | "impact_limit" | "expired" | "error" | "pending" | "success" | "uncertain" | "refund" | "approval_pending" | "approval_uncertain" | "approval_confirmed" | "approval_queued" | "approval_missing" | "approval_fee";
const scenes: Scene[] = ["disconnected", "quote", "quoting", "high_fee", "fee_boundary", "impact_limit", "expired", "error", "pending", "success", "uncertain", "refund", "approval_pending", "approval_uncertain", "approval_confirmed", "approval_queued", "approval_missing", "approval_fee"];

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const minutesAgo = (minutes: number) => Date.UTC(2026, 10, 10, 12, 0) - minutes * 60_000;
// One row per thing the board can say, on real routes and in real units.
const HISTORY_ROWS: BridgeHistoryEntry[] = [
  { requestId: hash(11), originChainId: 8453, destinationChainId: 4663, originAsset: "ETH", destinationAsset: "ETH", amountIn: "20000000000000000", inDecimals: 18, amountOut: "19962000000000000", outDecimals: 18, outKind: "quoted", status: "pending", reverted: false, createdAt: minutesAgo(1), sourceHash: hash(12), destinationHashes: [], recipient: null },
  { requestId: hash(21), originChainId: 42161, destinationChainId: 8453, originAsset: "USDC", destinationAsset: "USDC", amountIn: "25000000", inDecimals: 6, amountOut: "24975000", outDecimals: 6, outKind: "received", status: "success", reverted: false, createdAt: minutesAgo(48), sourceHash: hash(22), destinationHashes: [hash(23)], recipient: null },
  { requestId: hash(31), originChainId: 8453, destinationChainId: 4663, originAsset: "USDC", destinationAsset: "USDG", amountIn: "150000000", inDecimals: 6, amountOut: "149810000", outDecimals: 6, outKind: "received", status: "success", reverted: false, createdAt: minutesAgo(60 * 5), sourceHash: hash(32), destinationHashes: [hash(33)], recipient: null },
  { requestId: hash(41), originChainId: 8453, destinationChainId: 5042, originAsset: "USDC", destinationAsset: "USDC", amountIn: "60000000", inDecimals: 6, amountOut: "59940000000000000000", outDecimals: 18, outKind: "quoted", status: "delayed", reverted: false, createdAt: minutesAgo(60 * 9), sourceHash: hash(42), destinationHashes: [], recipient: null },
  { requestId: hash(51), originChainId: 1, destinationChainId: 5042, originAsset: "ETH", destinationAsset: "USDC", amountIn: "50000000000000000", inDecimals: 18, amountOut: "155300000000000000000", outDecimals: 18, outKind: "quoted", status: "refund", reverted: false, createdAt: minutesAgo(60 * 26), sourceHash: hash(52), destinationHashes: [], recipient: null },
  { requestId: hash(61), originChainId: 10, destinationChainId: 8453, originAsset: "ETH", destinationAsset: "ETH", amountIn: "8000000000000000", inDecimals: 18, amountOut: null, outDecimals: 18, outKind: null, status: "failure", reverted: true, createdAt: minutesAgo(60 * 50), sourceHash: hash(62), destinationHashes: [], recipient: null },
  { requestId: hash(71), originChainId: 4663, destinationChainId: 8453, originAsset: "ETH", destinationAsset: "ETH", amountIn: "4000000000000000", inDecimals: 18, amountOut: "3991000000000000", outDecimals: 18, outKind: "received", status: "success", reverted: false, createdAt: minutesAgo(60 * 80), sourceHash: hash(72), destinationHashes: [hash(73)], recipient: "0x9f3a2bE0c1D4e5F6a7b8C9d0E1f2A3b4C5d6E7F8" },
  { provider: "cctp", requestId: hash(81), originChainId: 42161, destinationChainId: 5042, originAsset: "USDC", destinationAsset: "USDC", amountIn: "40000000", inDecimals: 6, amountOut: "39983361000000000000", outDecimals: 18, outKind: "received", status: "success", reverted: false, createdAt: minutesAgo(60 * 96), sourceHash: hash(82), destinationHashes: [hash(83)], recipient: null },
];
type HistoryScene = "rows" | "empty" | "loading" | "no wallet" | "unsaved";
const HISTORY_SCENES: HistoryScene[] = ["rows", "empty", "loading", "no wallet", "unsaved"];

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
];

export default function BridgeReview() {
  const [historyScene, setHistoryScene] = useState<HistoryScene>("rows");
  const [open, setOpen] = useState(false);
  const [scene, setScene] = useState<Scene>("disconnected");
  const [route, setRoute] = useState<BridgeRouteInputs>({ originChainId: 8453, destinationChainId: 5042, originAsset: "USDC", destinationAsset: "USDC", amount: "25" });
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
    if (!open || (scene !== "idle" && scene !== "approval_confirmed") || !inputAmount) return;
    const timer = setTimeout(() => setScene("quote"), BRIDGE_QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, scene, inputAmount, amount, origin, destination, originAsset, destinationAsset]);
  const normalizedInput = inputAmount * 10n ** BigInt(18 - inputCurrency.decimals);
  const netAmount = normalizedInput * 9975n / 10000n;
  const converted = originAsset === destinationAsset ? netAmount : originAsset === "USDC" ? netAmount / 2400n : netAmount * 2400n;
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
  const approval: TrackedApproval | null = erc20Input && (origin === 5042 || origin === 8453) && (scene.startsWith("approval_") || approved) ? { version: 1, chainId: origin, address: wallet, token: inputCurrency.address, spender: viaCircle ? CCTP_TOKEN_MESSENGER.toLowerCase() as typeof RELAY : RELAY, amount: inputAmount.toString(), createdAt: clock, status: scene === "approval_uncertain" ? "uncertain" : scene === "approval_confirmed" || approved ? "confirmed" : "pending", ...(scene === "approval_uncertain" ? {} : { approvalHash: requestId }) } : null;
  const tracking = ["pending", "success", "uncertain", "refund"].includes(scene);
  const feeWarning = ["high_fee", "fee_boundary", "impact_limit"].includes(scene);
  const rejectedFee = scene === "fee_boundary" ? inputAmount / 20n + 1n : scene === "impact_limit" ? inputAmount / 400n : inputAmount * 55548n / 1_000_000n;
  const bridge: ReturnType<typeof useBridge> = {
    address: scene === "disconnected" ? undefined : wallet, walletChainId: origin,
    originChainId: origin, destinationChainId: destination, setOriginChainId: (chainId) => changeRoute({ side: "origin", chainId }), setDestinationChainId: (chainId) => changeRoute({ side: "destination", chainId }), reverseRoute: () => changeRoute({ side: "reverse" }), canReverse: canReverseBridgeRoute({ originChainId: origin }), amount, setAmount,
    originAsset, destinationAsset, setOriginAsset: (asset) => changeRoute({ side: "origin-asset", asset }), setDestinationAsset: (asset) => changeRoute({ side: "destination-asset", asset }),
    balance: parseUnits(originAsset === "USDC" ? "125" : "0.05", inputCurrency.decimals), nativeBalance: parseEther(origin === 5042 ? "125" : "0.05"), balanceLoading: false, balanceError: null,
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
  return (
    <>
    <main className="mx-auto max-w-3xl px-5 py-20">
      <h1 className="text-2xl font-semibold">Bridge visual review</h1>
      <p className="mt-3 text-sm text-body">Development-only synthetic data. No wallet requests, API calls, or funds.</p>
      <p className="mt-2 text-sm text-muted">Base offers ETH and USDC. Arc uses USDC. Robinhood offers ETH; its USDC routes currently fail our safety checks. USDC sends use an exact-amount approval.</p>
      <button type="button" aria-pressed={circle} className="mt-6 min-h-11 rounded-lg border border-line-strong px-4 text-sm aria-pressed:border-ink" onClick={() => { setCircle((value) => !value); if (!cctpRoute({ ...route, originAsset, destinationAsset })) setRoute({ originChainId: 8453, destinationChainId: 5042, originAsset: "USDC", destinationAsset: "USDC", amount: "25" }); }}>quote from: {circle ? "Circle" : "Relay"}</button>
      <div className="my-6 flex flex-wrap gap-2">{scenes.map((value) => <button key={value} type="button" className="min-h-11 rounded-lg border border-line-strong px-4 text-sm" onClick={() => { if (value.startsWith("approval_")) { if (!erc20Input) setRoute({ originChainId: 8453, destinationChainId: 5042, originAsset: "USDC", destinationAsset: "USDC", amount: "25" }); setApproved(value === "approval_confirmed"); } else if (!parseBridgeAmount(amount, inputCurrency.decimals)) setRoute((current) => ({ ...current, amount: originAsset === "USDC" ? "25" : "0.01" })); setScene(value); setOpen(true); }}>{value.replaceAll("_", " ")}</button>)}</div>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal><Dialog.Backdrop className={styles.backdrop} /><Dialog.Popup className={styles.panel} initialFocus={false}>
          <div className={styles.heading}><Dialog.Title className={styles.title}>Bridge</Dialog.Title><Dialog.Close className={styles.close} aria-label="Close preview"><X size={19} /></Dialog.Close></div>
          <Dialog.Description className={styles.description}>Preview only · {scene} · no funds move</Dialog.Description>
          {tracking ? <Transfer bridge={bridge} /> : <BridgeForm bridge={bridge} connect={() => setScene("quote")} />}
          <div className={styles.footer}><span>{viaCircle ? "Powered by Circle CCTP" : "Powered by Relay"}</span><span>0 Openlaunch fee</span></div>
        </Dialog.Popup></Dialog.Portal>
      </Dialog.Root>
      <div className="mt-16 flex flex-wrap gap-2">{HISTORY_SCENES.map((value) => <button key={value} type="button" aria-pressed={historyScene === value} className="min-h-11 rounded-lg border border-line-strong px-4 text-sm aria-pressed:border-ink" onClick={() => setHistoryScene(value)}>history: {value}</button>)}</div>
    </main>
    <div className="mx-auto max-w-6xl px-5 pb-24">
      <HistoryBoard wallet={historyScene === "no wallet" ? "" : wallet.toLowerCase()} rows={historyScene === "rows" || historyScene === "unsaved" ? HISTORY_ROWS : []} loading={historyScene === "loading"} unsaved={historyScene === "unsaved"} note="Preview only. Synthetic transfers, no wallet and no Relay call." onRefresh={() => {}} />
      <h2 className="mt-16 text-lg font-semibold">Bridge, then buy</h2>
      <p className="mt-2 text-sm text-body">The trade panel card, at trade panel width. Buttons do nothing here.</p>
      <div className="mt-6 grid gap-6 [grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr))]">
        {FUND_SCENES.map(({ name, ...scene }) => <figure key={name} className="m-0 grid min-w-0 content-start gap-2"><figcaption className="text-xs text-muted">{name}</figcaption><FundCard {...scene} onBridge={() => {}} onOpen={() => {}} onDismiss={() => {}} /></figure>)}
      </div>
    </div>
    </>
  );
}
