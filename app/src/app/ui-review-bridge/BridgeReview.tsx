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

const wallet = "0x03508bB71268BBA25ECaCC8F620e01866650532c" as const;
const requestId = `0x${"1".repeat(64)}` as const;
type Scene = "idle" | "disconnected" | "quote" | "quoting" | "high_fee" | "fee_boundary" | "impact_limit" | "expired" | "error" | "pending" | "success" | "uncertain" | "refund" | "approval_pending" | "approval_uncertain" | "approval_confirmed" | "approval_queued" | "approval_missing" | "approval_fee";
const scenes: Scene[] = ["disconnected", "quote", "quoting", "high_fee", "fee_boundary", "impact_limit", "expired", "error", "pending", "success", "uncertain", "refund", "approval_pending", "approval_uncertain", "approval_confirmed", "approval_queued", "approval_missing", "approval_fee"];

export default function BridgeReview() {
  const [open, setOpen] = useState(false);
  const [scene, setScene] = useState<Scene>("disconnected");
  const [route, setRoute] = useState<BridgeRouteInputs>({ originChainId: 8453, destinationChainId: 5042, originAsset: "USDC", destinationAsset: "USDC", amount: "25" });
  const [approved, setApproved] = useState(false);
  const { originChainId: origin, destinationChainId: destination, amount } = route;
  const originAsset = route.originAsset ?? defaultBridgeAsset(origin);
  const destinationAsset = route.destinationAsset ?? defaultBridgeAsset(destination);
  const inputCurrency = bridgeCurrency(origin, originAsset, "input");
  const outputCurrency = bridgeCurrency(destination, destinationAsset, "output");
  const erc20Input = inputCurrency.address !== zeroAddress;
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
  const outputAmount = converted / 10n ** BigInt(18 - outputCurrency.decimals);
  const quote: BridgeQuote = {
    address: wallet, originChainId: origin, destinationChainId: destination, originAsset, destinationAsset, amount: inputAmount.toString(),
    requestId, amountOut: outputAmount.toString(), minimumAmountOut: (outputAmount * 995n / 1000n).toString(), relayFee: formatUnits(inputAmount * 25n / 10000n, inputCurrency.decimals), sourceGas: origin === 5042 ? "0.001" : "0.0000007", totalImpactPercent: "-0.25", timeEstimate: 2, expiresAt: clock + 45_000, ttlMs: 45_000,
    transaction: { to: wallet, data: "0x", value: "0", chainId: origin }, // deliberately non-executable fixture
    ...(erc20Input ? { approval: { token: inputCurrency.address, spender: "0x4cd00e387622c35bddb9b4c962c136462338bc31" as const, amount: inputAmount.toString() } } : {}),
  };
  const approval: TrackedApproval | null = erc20Input && (origin === 5042 || origin === 8453) && (scene.startsWith("approval_") || approved) ? { version: 1, chainId: origin, address: wallet, token: inputCurrency.address, spender: "0x4cd00e387622c35bddb9b4c962c136462338bc31", amount: inputAmount.toString(), createdAt: clock, status: scene === "approval_uncertain" ? "uncertain" : scene === "approval_confirmed" || approved ? "confirmed" : "pending", ...(scene === "approval_uncertain" ? {} : { approvalHash: requestId }) } : null;
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
    tracked: tracking ? { address: wallet, requestId, amount: quote.amount, originChainId: origin, destinationChainId: destination, originAsset, destinationAsset, destinationHashes: [], status: scene as "pending" | "success" | "uncertain" | "refund", createdAt: clock } : null,
    statusError: null, retryStatus: () => {}, storageError: null, busy: false, canReset: scene === "success" || scene === "refund",
    approval, approvalRequired: erc20Input && !approved, allowanceLoading: false, approvalBusy: false, approvalError: null,
    approvalHealth: ["approval_queued", "approval_missing", "approval_fee"].includes(scene) ? describePendingApproval({ createdAt: clock - 70_000, now: clock, transaction: scene === "approval_missing" ? null : { nonce: 2, maxFeePerGas: 30_000_000_000n }, latestNonce: scene === "approval_queued" ? 0 : 2, baseFeePerGas: 166_000_000_000n }) : null,
    approve: async () => setScene("approval_pending"), retryApproval: () => { setApproved(true); setScene("approval_confirmed"); },
    recoverApproval: async () => { setApproved(true); setScene("approval_confirmed"); },
    approvalCanBeDiscarded: scene === "approval_uncertain", discardApproval: async () => { setApproved(false); setScene("idle"); },
    canDiscard: scene === "uncertain", discard: async () => setScene("idle"), discarding: false,
  };
  return (
    <main className="mx-auto max-w-3xl px-5 py-20">
      <h1 className="text-2xl font-semibold">Bridge visual review</h1>
      <p className="mt-3 text-sm text-body">Development-only synthetic data. No wallet requests, API calls, or funds.</p>
      <p className="mt-2 text-sm text-muted">Base offers ETH and USDC. Arc uses USDC. Robinhood offers ETH; its USDC routes currently fail our safety checks. USDC sends use an exact-amount approval.</p>
      <div className="my-6 flex flex-wrap gap-2">{scenes.map((value) => <button key={value} type="button" className="min-h-11 rounded-lg border border-line-strong px-4 text-sm" onClick={() => { if (value.startsWith("approval_")) { if (!erc20Input) setRoute({ originChainId: 8453, destinationChainId: 5042, originAsset: "USDC", destinationAsset: "USDC", amount: "25" }); setApproved(value === "approval_confirmed"); } else if (!parseBridgeAmount(amount, inputCurrency.decimals)) setRoute((current) => ({ ...current, amount: originAsset === "USDC" ? "25" : "0.01" })); setScene(value); setOpen(true); }}>{value.replaceAll("_", " ")}</button>)}</div>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal><Dialog.Backdrop className={styles.backdrop} /><Dialog.Popup className={styles.panel} initialFocus={false}>
          <div className={styles.heading}><Dialog.Title className={styles.title}>Bridge</Dialog.Title><Dialog.Close className={styles.close} aria-label="Close preview"><X size={19} /></Dialog.Close></div>
          <Dialog.Description className={styles.description}>Preview only · {scene} · no funds move</Dialog.Description>
          {tracking ? <Transfer bridge={bridge} /> : <BridgeForm bridge={bridge} connect={() => setScene("quote")} />}
          <div className={styles.footer}><span>Powered by Relay</span><span>0 Openlaunch fee</span></div>
        </Dialog.Popup></Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}
