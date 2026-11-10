"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl";
import { useAccount, useBalance, useConfig, useReadContract, useSwitchChain } from "wagmi";
import { getAccount, getPublicClient, getWalletClient } from "wagmi/actions";
import { estimateTotalFee } from "viem/op-stack";
import { erc20Abi, parseEther, TransactionReceiptNotFoundError, type Address } from "viem";
import { clientTranslator } from "@/i18n/client";
import { BRIDGE_WALLET_CHAINS } from "@/lib/bridge/chains";
import { BRIDGE_CHAINS, bridgeCurrency, defaultBridgeAsset, isBridgeAssetSupported, isBridgeChainId, type BridgeAsset, type BridgeChainId, type BridgeQuote, type BridgeQuoteRejection } from "@/lib/bridge/types";
import { bridgeServiceMessage, parseBridgeQuoteRejection } from "@/lib/bridge/client";
import { createBridgeQuoteSession } from "@/lib/bridge/quote-session";
import { activityAfterWalletChange, anchorQuoteExpiry, bridgeErrorMessage, bridgeGasBudget, bridgeRequest, bridgeRequestKey, changeBridgeRoute, hasMatchingDepositEvent, isHash, isMatchingSourceDeposit, linkedTimeoutSignal, mergeBridgeStatus, nativeSourceAmount, RELAY_DEPOSITORY, replacementSourceHash, submitBridgeDeposit, transferCanDiscard, transferIsTerminal, transferPhase, validateBridgeQuote, validateBridgeStatus, type BridgeActivity, type BridgePhase, type BridgeRouteChange, type BridgeRouteInputs, type ProviderObservation, type TrackedBridgeTransfer } from "@/lib/bridge/client";
import { BRIDGE_STORAGE_PREFIX, createBridgeTransferStore } from "@/lib/bridge/client-storage";
import { APPROVAL_STORAGE_PREFIX, approvalBlocksSubmission, approvalCanDiscard, canApplyApprovalPoll, createApprovalStore, reconcileApproval, recoverApprovalFromEvidence, submitExactApproval, validateApprovalMetadata, type ApprovalReceiptObservation } from "@/lib/bridge/approval";
import { APPROVAL_HEALTH_UNAVAILABLE, readPendingApprovalHealth, type ApprovalHealth } from "@/lib/bridge/approval-health";
import { assertBridgeWalletQueueClear } from "@/lib/bridge/transaction-preflight";

export type { BridgePhase, TrackedBridgeTransfer } from "@/lib/bridge/client";

// Created without touching window: the server snapshot and first client render
// are neutral. Storage is loaded after hydration and is scoped to the account.
const transfers = createBridgeTransferStore(() => window.localStorage);
const approvals = createApprovalStore(() => window.localStorage);
type QuoteEnvelope = { quote: BridgeQuote; key: string; walletChainId?: number; requestedAt: number };
type Issue = { key: string; message: string } | null;
type QuoteIssue = { key: string; walletChainId?: number; message: string; rejection?: BridgeQuoteRejection | null } | null;
const messageOf = bridgeErrorMessage;
const transferLockName = (address: Address) => `openlaunch:bridge:${address.toLowerCase()}`;

async function responseBody(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? bridgeServiceMessage(body.error) : clientTranslator("bridge")("errors.serviceUnavailable");
    throw new Error(message);
  }
  return body;
}

/** Mount once above the dialog so closing it never interrupts transfer recovery. */
export function useBridge(open: boolean) {
  const t = useTranslations("bridge");
  const config = useConfig();
  const { address, chainId: walletChainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const [route, setRoute] = useState<BridgeRouteInputs>({ originChainId: 8453, destinationChainId: 4663, originAsset: "ETH", destinationAsset: "ETH", amount: "" });
  const { originChainId, destinationChainId, amount } = route;
  const originAsset = route.originAsset ?? defaultBridgeAsset(originChainId);
  const destinationAsset = route.destinationAsset ?? defaultBridgeAsset(destinationChainId);
  const inputCurrency = bridgeCurrency(originChainId, originAsset, "input");
  const inputIsToken = !/^0x0{40}$/.test(inputCurrency.address);
  const [envelope, setEnvelope] = useState<QuoteEnvelope | null>(null);
  const [activity, setActivity] = useState<BridgeActivity>({ key: "", phase: "idle" });
  const [issue, setIssue] = useState<Issue>(null);
  const [quoteIssue, setQuoteIssue] = useState<QuoteIssue>(null);
  const [statusIssue, setStatusIssue] = useState<Issue>(null);
  const [expiredId, setExpiredId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [pollRevision, setPollRevision] = useState(0);
  const [approvalPollRevision, setApprovalPollRevision] = useState(0);
  const [approvalSending, setApprovalSending] = useState(false);
  const [approvalIssue, setApprovalIssue] = useState<Issue>(null);
  const [allowanceResult, setAllowanceResult] = useState<{ key: string; value: bigint | null; error: string | null } | null>(null);
  const [observation, setObservation] = useState<ProviderObservation | null>(null);
  const [approvalObservation, setApprovalObservation] = useState<ApprovalReceiptObservation | null>(null);
  const [approvalHealthResult, setApprovalHealthResult] = useState<{ wallet: string; createdAt: number; hash: string; value: ApprovalHealth | null } | null>(null);
  const [now, setNow] = useState(0);
  const [discarding, setDiscarding] = useState(false);
  const actionLock = useRef(false);
  const [quoteSession] = useState(createBridgeQuoteSession);
  const inputs = useRef<BridgeRouteInputs>({ originChainId: 8453, destinationChainId: 4663, originAsset: "ETH", destinationAsset: "ETH", amount: "" });
  const snapshot = useSyncExternalStore(transfers.subscribe, transfers.getSnapshot, transfers.getServerSnapshot);
  const approvalSnapshot = useSyncExternalStore(approvals.subscribe, approvals.getSnapshot, approvals.getServerSnapshot);
  const walletKey = address?.toLowerCase() ?? "";
  const tracked = snapshot.transfers[walletKey] ?? null;
  const approval = approvalSnapshot.approvals[walletKey] ?? null;
  const approvalPending = approvalBlocksSubmission(approval);
  const storageError = snapshot.errors[walletKey] ?? approvalSnapshot.errors[walletKey] ?? null;
  const request = bridgeRequest(address, originChainId, amount, destinationChainId, originAsset, destinationAsset);
  const requestKey = bridgeRequestKey(request);
  const quote = envelope?.key === requestKey && envelope.walletChainId === walletChainId ? envelope.quote : null;
  const quoteExpired = !!quote && expiredId === quote.requestId;
  const allowanceLoading = !!quote?.approval && allowanceResult?.key !== quote.requestId;
  const approvalRequired = !!quote?.approval && (allowanceResult?.key !== quote.requestId || allowanceResult.value === null || allowanceResult.value < BigInt(quote.approval.amount));
  const sourceBalance = useBalance({ address, chainId: originChainId, query: { enabled: !!address, refetchInterval: 15_000 } });
  const tokenBalance = useReadContract({ address: inputCurrency.address, abi: erc20Abi, functionName: "balanceOf", args: address ? [address] : undefined, chainId: originChainId, query: { enabled: !!address && inputIsToken, refetchInterval: 15_000 } });
  const cancelQuote = quoteSession.cancel;
  const currentQuoteIssue = quoteIssue?.key === requestKey && quoteIssue.walletChainId === walletChainId ? quoteIssue : null;

  useEffect(() => {
    if (!address) return;
    const refresh = () => {
      try { transfers.read(address); } catch { /* surfaced in the store */ }
      try { approvals.read(address); } catch { /* surfaced in the store */ }
    };
    refresh();
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === `${BRIDGE_STORAGE_PREFIX}${address.toLowerCase()}` || event.key === `${APPROVAL_STORAGE_PREFIX}${address.toLowerCase()}`) refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [address]);

  // Existing quotes are hidden immediately by their wallet-chain key. Abort
  // in-flight responses as well; an old account's response cannot reappear.
  // The aborted request skips its own idle reset, so clear a quoting phase here
  // or the form stays locked on "Finding your route…".
  useEffect(() => () => {
    cancelQuote();
    setActivity(activityAfterWalletChange);
  }, [address, walletChainId, cancelQuote]);

  useEffect(() => {
    if (!quote) return;
    const timer = window.setTimeout(() => setExpiredId(quote.requestId), Math.max(0, quote.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [quote]);

  useEffect(() => {
    if (!quote?.approval) return;
    let stopped = false;
    const pub = getPublicClient(config, { chainId: quote.originChainId });
    if (!pub) return;
    void Promise.all([pub.getChainId(), pub.readContract({ address: quote.approval.token, abi: erc20Abi, functionName: "allowance", args: [quote.address, RELAY_DEPOSITORY] })]).then(([chainId, value]) => {
      if (chainId !== quote.originChainId) throw new Error(clientTranslator("bridge")("errors.approvalRpcNetwork"));
      if (!stopped) setAllowanceResult({ key: quote.requestId, value, error: null });
    }).catch((error) => {
      if (!stopped) setAllowanceResult({ key: quote.requestId, value: null, error: messageOf(error, clientTranslator("bridge")("errors.allowanceUnreadable")) });
    });
    return () => { stopped = true; };
  }, [quote, config]);

  const approvalId = approval?.createdAt;
  const approvalHash = approval?.approvalHash;
  useEffect(() => {
    // An unknown broadcast cannot be resolved from allowance alone. Wait for
    // a wallet-returned or manually verified hash before polling its source chain.
    if (!address || !approvalId || !approvalHash) return;
    let stopped = false;
    let active = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (stopped || active) return;
      active = true;
      clearTimeout(timer);
      try {
        const observed = approvals.getSnapshot().approvals[address.toLowerCase()];
        if (!observed || !approvalBlocksSubmission(observed) || observed.createdAt !== approvalId || observed.approvalHash !== approvalHash) return;
        const pub = getPublicClient(config, { chainId: observed.chainId });
        if (!pub) throw new Error(clientTranslator("bridge")("errors.approvalSourceOffline"));
        const [chainId, allowance, receipt] = await Promise.all([
          pub.getChainId(),
          pub.readContract({ address: observed.token, abi: erc20Abi, functionName: "allowance", args: [address, RELAY_DEPOSITORY] }),
          pub.getTransactionReceipt({ hash: approvalHash }).catch((error) => {
            if (error instanceof TransactionReceiptNotFoundError) return null;
            throw error;
          }),
        ]);
        if (chainId !== observed.chainId) throw new Error(clientTranslator("bridge")("errors.approvalRpcNetworkRetry"));
        // Diagnostics never substitute for a receipt or allowance, and failed
        // optional reads cannot stop an already-mined approval from resolving.
        const health = receipt ? null : await readPendingApprovalHealth(pub, observed, Date.now());
        const apply = (persist: boolean) => {
          const current = approvals.read(address);
          if (stopped || !current || !canApplyApprovalPoll(current, observed)) return;
          const next = reconcileApproval(current, { chainId, allowance, receipt });
          if (persist) {
            try { approvals.save(next); } catch { /* memory retains the receipt result */ }
          } else approvals.remember(next);
          setApprovalObservation({ createdAt: current.createdAt, receiptFound: receipt !== null, observedAt: Date.now() });
          setApprovalHealthResult({ wallet: address.toLowerCase(), createdAt: current.createdAt, hash: approvalHash, value: health });
          setApprovalIssue(null);
        };
        if (navigator.locks) await navigator.locks.request(transferLockName(address), { ifAvailable: true }, (lock) => { if (lock) apply(true); });
        else apply(false);
      } catch (error) {
        const current = approvals.getSnapshot().approvals[address.toLowerCase()];
        if (!stopped && current?.createdAt === approvalId && current.approvalHash === approvalHash && approvalBlocksSubmission(current)) {
          setApprovalHealthResult({ wallet: address.toLowerCase(), createdAt: approvalId, hash: approvalHash, value: APPROVAL_HEALTH_UNAVAILABLE });
          setApprovalIssue({ key: address.toLowerCase(), message: messageOf(error, clientTranslator("bridge")("errors.approvalStatusUnavailable")) });
        }
      } finally {
        active = false;
        const current = approvals.getSnapshot().approvals[address.toLowerCase()];
        if (!stopped && current?.createdAt === approvalId && current.approvalHash === approvalHash && approvalBlocksSubmission(current)) timer = setTimeout(() => void poll(), 8_000);
      }
    };
    void poll();
    const focus = () => { void poll(); };
    window.addEventListener("focus", focus);
    return () => { stopped = true; clearTimeout(timer); window.removeEventListener("focus", focus); };
  }, [address, approvalId, approvalHash, approvalPollRevision, config]);

  const trackedId = tracked?.requestId;
  const settled = transferIsTerminal(tracked);
  useEffect(() => {
    if (!address || !trackedId || settled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let active = false;
    let failures = 0;
    const poll = async () => {
      if (stopped || active) return;
      active = true;
      clearTimeout(timer);
      controller = new AbortController();
      try {
        const observed = transfers.getSnapshot().transfers[address.toLowerCase()];
        const pub = observed ? getPublicClient(config, { chainId: observed.originChainId }) : undefined;
        const [provider, receipt] = await Promise.allSettled([
          fetch(`/api/bridge/status?requestId=${encodeURIComponent(trackedId)}`, { cache: "no-store", signal: linkedTimeoutSignal(controller.signal, 15_000) }).then(responseBody).then(validateBridgeStatus),
          // "Not found" is a real answer (unmined, dropped or replaced); other RPC failures stay unknown.
          observed?.sourceHash && pub ? Promise.all([pub.getChainId(), pub.getTransactionReceipt({ hash: observed.sourceHash }).catch((error) => {
            if (error instanceof TransactionReceiptNotFoundError) return null;
            throw error;
          })]).then(([chainId, result]) => chainId === observed.originChainId ? result : null) : Promise.resolve(null),
        ]);
        if (stopped) return;
        const applyStatus = async (persist: boolean) => {
          let current = transfers.read(address);
          if (stopped || !current || current.requestId !== trackedId || transferIsTerminal(current)) return;
          let next: TrackedBridgeTransfer;
          if (receipt.status === "fulfilled" && receipt.value?.status === "reverted" && receipt.value.transactionHash.toLowerCase() === current.sourceHash?.toLowerCase()) {
            next = { ...current, status: "failure", failureReason: "source-reverted" };
          } else {
            if (provider.status === "rejected") throw provider.reason;
            const status = provider.value;
            // The candidate must still be this wallet's exact deposit for this order.
            const candidate = pub ? replacementSourceHash(current, status, receipt.status === "fulfilled" && receipt.value === null) : null;
            if (candidate && pub) {
              const [chainId, transaction] = await Promise.all([pub.getChainId(), pub.getTransaction({ hash: candidate })]);
              if (chainId !== current.originChainId) throw new Error(clientTranslator("bridge")("errors.sourceRpcNetworkTracking"));
              const matched = isMatchingSourceDeposit(current, transaction) || hasMatchingDepositEvent(current, await pub.getTransactionReceipt({ hash: candidate }));
              if (!matched) throw new Error(clientTranslator("bridge")("errors.sourceUnmatched"));
              current = { ...current, sourceHash: candidate };
            }
            next = mergeBridgeStatus(current, status);
            setObservation({ requestId: current.requestId, status, sourceMined: receipt.status === "rejected" || (receipt.status === "fulfilled" && receipt.value !== null), observedAt: Date.now() });
          }
          if (stopped) return;
          if (persist) {
            try { transfers.save(next); } catch { /* retained in memory; pre-send recovery remains durable */ }
          } else transfers.remember(next);
          setStatusIssue(null);
          failures = 0;
        };
        if (navigator.locks) {
          await navigator.locks.request(transferLockName(address), { ifAvailable: true }, async (lock) => { if (lock) await applyStatus(true); });
        } else await applyStatus(false); // read-only recovery remains available in older browsers
      } catch (error) {
        if (stopped) return;
        failures++;
        setStatusIssue({ key: trackedId, message: messageOf(error, clientTranslator("bridge")("errors.statusRefreshFailed")) });
      } finally {
        active = false;
        const current = transfers.getSnapshot().transfers[address.toLowerCase()];
        if (!stopped && current?.requestId === trackedId && !transferIsTerminal(current)) timer = setTimeout(() => void poll(), Math.min(30_000, 6_000 * 2 ** Math.min(failures, 3)));
      }
    };
    void poll();
    const focus = () => { void poll(); };
    window.addEventListener("focus", focus);
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); window.removeEventListener("focus", focus); };
  }, [address, trackedId, settled, pollRevision, config]);

  function invalidateQuote() {
    cancelQuote();
    setEnvelope(null);
    setExpiredId(null);
    setQuoteIssue(null);
    setIssue(null);
    setActivity({ key: "", phase: "idle" });
  }

  function updateRoute(change: BridgeRouteChange) {
    if (actionLock.current || approvalPending || (tracked && !transferIsTerminal(tracked))) return;
    const next = changeBridgeRoute(inputs.current, change);
    if (next.originChainId === inputs.current.originChainId && next.destinationChainId === inputs.current.destinationChainId && next.originAsset === inputs.current.originAsset && next.destinationAsset === inputs.current.destinationAsset && next.amount === inputs.current.amount) return;
    inputs.current = next;
    setRoute(next);
    invalidateQuote();
  }

  function setOriginChainId(chainId: BridgeChainId) {
    if (isBridgeChainId(chainId)) updateRoute({ side: "origin", chainId });
  }

  function setDestinationChainId(chainId: BridgeChainId) {
    if (isBridgeChainId(chainId)) updateRoute({ side: "destination", chainId });
  }

  function setOriginAsset(asset: BridgeAsset) {
    if (isBridgeAssetSupported(inputs.current.originChainId, asset)) updateRoute({ side: "origin-asset", asset });
  }

  function setDestinationAsset(asset: BridgeAsset) {
    if (isBridgeAssetSupported(inputs.current.destinationChainId, asset)) updateRoute({ side: "destination-asset", asset });
  }

  function reverseRoute() { updateRoute({ side: "reverse" }); }

  function setAmount(value: string) {
    if (actionLock.current || approvalPending || (tracked && !transferIsTerminal(tracked))) return;
    if (value === inputs.current.amount) return;
    const next = { ...inputs.current, amount: value };
    inputs.current = next;
    setRoute(next);
    invalidateQuote();
  }

  const requestQuote = useCallback(async () => {
    if (actionLock.current || approvalPending || (tracked && !transferIsTerminal(tracked))) return;
    const connected = getAccount(config);
    const current = bridgeRequest(connected.address, inputs.current.originChainId, inputs.current.amount, inputs.current.destinationChainId, inputs.current.originAsset, inputs.current.destinationAsset);
    if (!current) {
      const currency = bridgeCurrency(inputs.current.originChainId, inputs.current.originAsset, "input");
      setQuoteIssue({ key: requestKey, walletChainId: connected.chainId, message: !connected.address ? clientTranslator("bridge")("errors.connectForQuote") : clientTranslator("bridge")("errors.invalidAmount", { symbol: currency.symbol, decimals: String(currency.decimals) }) });
      return;
    }
    const key = bridgeRequestKey(current);
    const requestedAt = Date.now();
    setEnvelope(null);
    setExpiredId(null);
    setQuoteIssue(null);
    setActivity({ key, phase: "quoting" });
    await quoteSession.run(async ({ signal, isCurrent }) => {
      const canApply = () => {
        const wallet = getAccount(config);
        return isCurrent() && wallet.address?.toLowerCase() === current.address.toLowerCase() && wallet.chainId === connected.chainId;
      };
      try {
        if (approvalBlocksSubmission(approvals.read(current.address))) throw new Error(clientTranslator("bridge")("errors.approvalTrackedQuote"));
        const response = await fetch("/api/bridge/quote", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(current), cache: "no-store",
          signal: linkedTimeoutSignal(signal, 20_000),
        });
        const body: unknown = await response.json();
        if (!canApply()) return;
        if (!response.ok) {
          const data = body && typeof body === "object" ? body : {};
          const message = "error" in data && typeof data.error === "string" ? bridgeServiceMessage(data.error) : clientTranslator("bridge")("errors.quoteFailed");
          const rejection = response.status === 422 && "quoteRejection" in data ? parseBridgeQuoteRejection(data.quoteRejection, current) : null;
          setQuoteIssue({ key, walletChainId: connected.chainId, message, rejection });
          return;
        }
        const next = validateBridgeQuote(anchorQuoteExpiry(body, requestedAt), current, Date.now());
        setEnvelope({ quote: next, key, walletChainId: connected.chainId, requestedAt });
      } catch (error) {
        if (!canApply()) return;
        setQuoteIssue({ key, walletChainId: connected.chainId, message: messageOf(error, clientTranslator("bridge")("errors.quoteFailed")) });
      } finally {
        if (isCurrent()) setActivity({ key, phase: "idle" });
      }
    });
  }, [approvalPending, tracked, config, requestKey, quoteSession]);

  const autoQuoteEnabled = open && !!request && !sending && !approvalSending && !approvalPending && !tracked;
  useEffect(() => {
    if (!autoQuoteEnabled) return;
    const cancel = quoteSession.schedule(() => { void requestQuote(); });
    return () => { cancel(); setActivity(activityAfterWalletChange); };
    // Include the raw amount: editing "1" to "1.0" invalidates the old display
    // even though both normalize to the same request key. Balance polls do not.
  }, [autoQuoteEnabled, amount, walletChainId, requestQuote, quoteSession]);

  async function approve() {
    if (actionLock.current || !quote?.approval || quoteExpired || approvalPending || (tracked && !transferIsTerminal(tracked))) return;
    actionLock.current = true;
    cancelQuote();
    setApprovalSending(true);
    setApprovalIssue(null);
    const reviewed = quote;
    const operationKey = bridgeRequestKey(reviewed);
    setEnvelope(null);
    try {
      validateBridgeQuote(reviewed, reviewed, Date.now());
      const request = validateApprovalMetadata(reviewed.approval, reviewed.address, reviewed.originChainId);
      if (!navigator.locks) throw new Error(clientTranslator("bridge")("errors.noLocksApproval"));
      await navigator.locks.request(transferLockName(reviewed.address), { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error(clientTranslator("bridge")("errors.otherTabApproval"));
        const pub = getPublicClient(config, { chainId: reviewed.originChainId });
        if (!pub) throw new Error(clientTranslator("bridge")("errors.sourceOfflineRequote"));
        let wallet: Awaited<ReturnType<typeof getWalletClient>> | undefined;
        const currentRequest = () => {
          const current = bridgeRequest(getAccount(config).address, inputs.current.originChainId, inputs.current.amount, inputs.current.destinationChainId, inputs.current.originAsset, inputs.current.destinationAsset);
          const deposit = transfers.read(reviewed.address);
          if (bridgeRequestKey(current) !== operationKey || (deposit && !transferIsTerminal(deposit))) return null;
          return request;
        };
        const result = await submitExactApproval(request, {
          now: Date.now,
          currentRequest,
          readWallet: async () => {
            if (!getAccount(config).address) return {};
            wallet = await getWalletClient(config);
            const [accounts, chainId] = await Promise.all([wallet.getAddresses(), wallet.getChainId()]);
            return { address: getAccount(config).address?.toLowerCase() === accounts[0]?.toLowerCase() ? accounts[0] : undefined, chainId };
          },
          switchChain: (chainId) => switchChainAsync({ chainId }),
          prepare: async (owner, transaction) => {
            await assertBridgeWalletQueueClear(pub, owner.address, BRIDGE_CHAINS[transaction.chainId].name);
            const call = { account: owner.address, to: transaction.to, data: transaction.data, value: transaction.value };
            const [chainId, balance, estimate, fees, allowance, selectedBalance, additional] = await Promise.all([
              pub.getChainId(), pub.getBalance({ address: owner.address }), pub.estimateGas(call), pub.estimateFeesPerGas(),
              pub.readContract({ address: transaction.to, abi: erc20Abi, functionName: "allowance", args: [owner.address, RELAY_DEPOSITORY] }),
              pub.readContract({ address: transaction.to, abi: erc20Abi, functionName: "balanceOf", args: [owner.address] }),
              reviewed.originChainId === 8453 ? estimateTotalFee(pub, call) : Promise.resolve(0n),
            ]);
            if (chainId !== reviewed.originChainId) throw new Error(clientTranslator("bridge")("errors.sourceRpcNetwork"));
            if (selectedBalance < BigInt(owner.amount)) throw new Error(clientTranslator("bridge")("errors.usdcShortApproval"));
            if (allowance >= BigInt(owner.amount)) throw new Error(clientTranslator("bridge")("errors.allowanceSufficient"));
            if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined) throw new Error(clientTranslator("bridge")("errors.approvalFees"));
            // Arc's token shares its gas balance; Base USDC has a separate ETH
            // gas balance. Reserve approval and quoted deposit costs in native units.
            const budget = bridgeGasBudget(nativeSourceAmount(reviewed), balance, estimate, fees.maxFeePerGas, parseEther(reviewed.sourceGas) + additional, BRIDGE_CHAINS[reviewed.originChainId].symbol);
            return { gas: budget.gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
          },
          readApproval: (owner) => approvals.read(owner),
          saveApproval: (record) => approvals.save(record),
          removeApproval: (owner) => approvals.remove(owner),
          send: (owner, transaction, gas) => {
            const connected = getAccount(config);
            if (!wallet || !currentRequest() || connected.address?.toLowerCase() !== owner.address.toLowerCase() || connected.chainId !== transaction.chainId) throw new Error("Wallet changed before approval submission");
            return wallet.sendTransaction({ account: owner.address, chain: BRIDGE_WALLET_CHAINS[transaction.chainId], to: transaction.to, data: transaction.data, value: 0n, ...gas });
          },
          phase: (phase) => setActivity({ key: operationKey, phase }),
        });
        if (result.kind === "rejected") setApprovalIssue({ key: reviewed.address.toLowerCase(), message: clientTranslator("bridge")("errors.approvalDeclined") });
        if (result.kind === "uncertain") setApprovalIssue({ key: reviewed.address.toLowerCase(), message: clientTranslator("bridge")("errors.approvalNoHash") });
      });
    } catch (error) {
      setApprovalIssue({ key: reviewed.address.toLowerCase(), message: messageOf(error, clientTranslator("bridge")("errors.approvalPrepare"), BRIDGE_CHAINS[reviewed.originChainId].symbol) });
    } finally {
      actionLock.current = false;
      setApprovalSending(false);
      setActivity({ key: operationKey, phase: "idle" });
      void sourceBalance.refetch();
      if (inputIsToken) void tokenBalance.refetch();
    }
  }

  async function recoverApproval(hash: string) {
    if (actionLock.current || !address || !approval || !approvalBlocksSubmission(approval)) return;
    if (!isHash(hash) || /^0x0+$/.test(hash)) {
      setApprovalIssue({ key: address.toLowerCase(), message: clientTranslator("bridge")("errors.enterApprovalHash") });
      return;
    }
    actionLock.current = true;
    setApprovalSending(true);
    setApprovalIssue(null);
    try {
      if (!navigator.locks) throw new Error(clientTranslator("bridge")("errors.noLocksRecover"));
      await navigator.locks.request(transferLockName(address), { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error(clientTranslator("bridge")("errors.otherTabRecover"));
        const current = approvals.read(address);
        if (!current || current.createdAt !== approval.createdAt || current.approvalHash !== approval.approvalHash || !approvalBlocksSubmission(current)) throw new Error(clientTranslator("bridge")("errors.approvalChanged"));
        const pub = getPublicClient(config, { chainId: current.chainId });
        if (!pub) throw new Error(clientTranslator("bridge")("errors.approvalNetworkOfflineCheck"));
        const [chainId, transaction, receipt, allowance] = await Promise.all([
          pub.getChainId(), pub.getTransaction({ hash }), pub.getTransactionReceipt({ hash }),
          pub.readContract({ address: current.token, abi: erc20Abi, functionName: "allowance", args: [address, RELAY_DEPOSITORY] }),
        ]);
        if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error(clientTranslator("bridge")("errors.receiptMismatch"));
        const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
        const next = recoverApprovalFromEvidence(current, { chainId, transaction, receipt, allowance, blockTimestamp: block.timestamp, now: Date.now() });
        approvals.save(next);
      });
    } catch (error) {
      setApprovalIssue({ key: address.toLowerCase(), message: messageOf(error, clientTranslator("bridge")("errors.approvalVerifyFailed")) });
    } finally {
      actionLock.current = false;
      setApprovalSending(false);
    }
  }

  async function confirm() {
    if (actionLock.current || !quote || quoteExpired || approvalPending || allowanceLoading || approvalRequired || (tracked && !transferIsTerminal(tracked))) return;
    actionLock.current = true;
    cancelQuote();
    setSending(true);
    setIssue(null);
    const reviewed = quote;
    const reviewedAt = envelope?.requestedAt ?? 0;
    const operationKey = bridgeRequestKey(reviewed);
    setActivity({ key: operationKey, phase: "switching" });
    // Never reuse this review after an interrupted/rejected confirmation.
    setEnvelope(null);
    try {
      const execute = async () => {
        const approvalRecord = approvals.read(reviewed.address);
        if (approvalBlocksSubmission(approvalRecord)) throw new Error(clientTranslator("bridge")("errors.approvalTrackedDeposit"));
        if (reviewed.approval && approvalRecord && reviewedAt <= approvalRecord.createdAt) throw new Error(clientTranslator("bridge")("errors.requoteAfterApproval"));
        let wallet: Awaited<ReturnType<typeof getWalletClient>> | undefined;
        const result = await submitBridgeDeposit(reviewed, {
          now: Date.now,
          currentRequest: () => bridgeRequest(getAccount(config).address, inputs.current.originChainId, inputs.current.amount, inputs.current.destinationChainId, inputs.current.originAsset, inputs.current.destinationAsset),
          readWallet: async () => {
            const connected = getAccount(config);
            if (!connected.address) return {};
            wallet = await getWalletClient(config);
            const [accounts, chainId] = await Promise.all([wallet.getAddresses(), wallet.getChainId()]);
            // Both Wagmi and the provider must still identify the reviewed account.
            const latest = getAccount(config);
            return { address: latest.address?.toLowerCase() === accounts[0]?.toLowerCase() ? accounts[0] : undefined, chainId };
          },
          switchChain: (chainId) => switchChainAsync({ chainId }),
          prepare: async (q) => {
            const pub = getPublicClient(config, { chainId: q.originChainId });
            if (!pub) throw new Error(clientTranslator("bridge")("errors.sourceOffline"));
            await assertBridgeWalletQueueClear(pub, q.address, BRIDGE_CHAINS[q.originChainId].name);
            const transaction = { account: q.address, to: q.transaction.to, data: q.transaction.data, value: BigInt(q.transaction.value) };
            const [rpcChain, balance, estimate, fees, additional, allowance, selectedBalance] = await Promise.all([
              pub.getChainId(), pub.getBalance({ address: q.address }), pub.estimateGas(transaction), pub.estimateFeesPerGas(),
              // Base charges L1 data/operator fees in addition to execution gas.
              // Reserving the total estimate here is intentionally conservative.
              q.originChainId === 8453 ? estimateTotalFee(pub, transaction) : Promise.resolve(0n),
              q.approval ? pub.readContract({ address: q.approval.token, abi: erc20Abi, functionName: "allowance", args: [q.address, RELAY_DEPOSITORY] }) : Promise.resolve(null),
              q.approval ? pub.readContract({ address: q.approval.token, abi: erc20Abi, functionName: "balanceOf", args: [q.address] }) : Promise.resolve(null),
            ]);
            if (rpcChain !== q.originChainId) throw new Error(clientTranslator("bridge")("errors.sourceRpcNetworkLater"));
            if (q.approval && (allowance === null || allowance < BigInt(q.amount))) throw new Error(clientTranslator("bridge")("errors.allowanceShort"));
            if (q.approval && (selectedBalance === null || selectedBalance < BigInt(q.amount))) throw new Error(clientTranslator("bridge")("errors.usdcShortDeposit"));
            if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined) throw new Error(clientTranslator("bridge")("errors.networkFees"));
            const budget = bridgeGasBudget(nativeSourceAmount(q), balance, estimate, fees.maxFeePerGas, additional, BRIDGE_CHAINS[q.originChainId].symbol);
            return { gas: budget.gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
          },
          readTransfer: (owner) => transfers.read(owner),
          saveTransfer: (transfer) => transfers.save(transfer),
          removeTransfer: (owner) => transfers.remove(owner),
          send: (q, gas) => {
            const connected = getAccount(config);
            if (!wallet || connected.address?.toLowerCase() !== q.address.toLowerCase() || connected.chainId !== q.originChainId) throw new Error("Wallet changed before submission");
            return wallet.sendTransaction({ account: q.address, chain: BRIDGE_WALLET_CHAINS[q.originChainId], to: q.transaction.to, data: q.transaction.data, value: BigInt(q.transaction.value), ...gas });
          },
          phase: (phase) => setActivity({ key: operationKey, phase }),
        });
        if (result.kind === "rejected") setIssue({ key: reviewed.address.toLowerCase(), message: clientTranslator("bridge")("errors.depositDeclined") });
        if (result.kind === "uncertain") setIssue({ key: reviewed.address.toLowerCase(), message: clientTranslator("bridge")("errors.depositNoHash") });
      };
      // Keep the lock across the wallet prompt: two tabs must never replace
      // one another's recovery record or prompt for two deposits.
      if (navigator.locks) {
        await navigator.locks.request(transferLockName(reviewed.address), { ifAvailable: true }, async (lock) => {
          if (!lock) throw new Error(clientTranslator("bridge")("errors.otherTabDeposit"));
          await execute();
        });
      } else throw new Error(clientTranslator("bridge")("errors.noLocksDeposit"));
    } catch (error) {
      setIssue({ key: reviewed.address.toLowerCase(), message: messageOf(error, clientTranslator("bridge")("errors.depositPrepare"), BRIDGE_CHAINS[reviewed.originChainId].symbol) });
    } finally {
      actionLock.current = false;
      setSending(false);
      setActivity({ key: operationKey, phase: "idle" });
      void sourceBalance.refetch();
      if (inputIsToken) void tokenBalance.refetch();
    }
  }

  function reset() {
    if (actionLock.current || approvalPending || (tracked && !transferIsTerminal(tracked))) return;
    if (address && tracked) {
      const requestId = tracked.requestId;
      if (!navigator.locks) return;
      void navigator.locks.request(transferLockName(address), { ifAvailable: true }, (lock) => {
        if (!lock) return;
        try {
          const current = transfers.read(address);
          if (current?.requestId !== requestId || !transferIsTerminal(current)) return;
          transfers.remove(address);
          invalidateQuote();
          setStatusIssue(null);
        } catch { /* storage warning is exposed in the store */ }
      });
    } else { invalidateQuote(); setStatusIssue(null); }
  }

  // Discard eligibility depends on wall-clock age. Render stays pure: the clock
  // is state, refreshed after every observation and once a minute while a record is open.
  const blocked = (tracked && !transferIsTerminal(tracked)) || approvalPending;
  useEffect(() => {
    if (!blocked) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 60_000);
    return () => window.clearInterval(timer);
  }, [blocked, observation, approvalObservation]);
  const canDiscard = transferCanDiscard(tracked, observation, now);
  const approvalCanBeDiscarded = approvalCanDiscard(approval, approvalObservation, now);

  const receiptOrNull = (pub: NonNullable<ReturnType<typeof getPublicClient>>, hash: `0x${string}`) => pub.getTransactionReceipt({ hash }).catch((error: unknown) => {
    if (error instanceof TransactionReceiptNotFoundError) return null;
    throw error;
  });

  // Both discards re-read Relay and the source chain under the wallet lock. The
  // observation that showed the button only decides visibility, never removal.
  async function discard() {
    if (actionLock.current || sending || discarding || !address || !tracked || !canDiscard || !navigator.locks) return;
    const requestId = tracked.requestId;
    setDiscarding(true);
    try {
      await navigator.locks.request(transferLockName(address), { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error(clientTranslator("bridge")("errors.busy"));
        const current = transfers.read(address);
        if (current?.requestId !== requestId || transferIsTerminal(current)) return;
        const status = await fetch(`/api/bridge/status?requestId=${encodeURIComponent(requestId)}`, { cache: "no-store", signal: linkedTimeoutSignal(undefined, 15_000) }).then(responseBody).then(validateBridgeStatus);
        let sourceMined = false;
        if (current.sourceHash) {
          const pub = getPublicClient(config, { chainId: current.originChainId });
          if (!pub) throw new Error(clientTranslator("bridge")("errors.sourceOffline"));
          const [chainId, receipt] = await Promise.all([pub.getChainId(), receiptOrNull(pub, current.sourceHash)]);
          if (chainId !== current.originChainId) throw new Error(clientTranslator("bridge")("errors.sourceRpcNetworkAgain"));
          sourceMined = receipt !== null;
        }
        const fresh = { requestId, status, sourceMined, observedAt: Date.now() };
        setObservation(fresh);
        if (!transferCanDiscard(current, fresh, Date.now())) throw new Error(clientTranslator("bridge")("errors.transferKept"));
        transfers.remove(address);
        setObservation(null);
        invalidateQuote();
        setStatusIssue(null);
      });
    } catch (error) {
      setStatusIssue({ key: requestId, message: messageOf(error, clientTranslator("bridge")("errors.transferDiscardFailed")) });
    } finally {
      setDiscarding(false);
    }
  }

  async function discardApproval() {
    if (actionLock.current || approvalSending || discarding || !address || !approval || !approvalCanBeDiscarded || !navigator.locks) return;
    const createdAt = approval.createdAt;
    setDiscarding(true);
    try {
      await navigator.locks.request(transferLockName(address), { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error(clientTranslator("bridge")("errors.busy"));
        const current = approvals.read(address);
        if (current?.createdAt !== createdAt || !approvalBlocksSubmission(current)) return;
        let fresh: ApprovalReceiptObservation | null = null;
        if (current.approvalHash) {
          const pub = getPublicClient(config, { chainId: current.chainId });
          if (!pub) throw new Error(clientTranslator("bridge")("errors.approvalNetworkOffline"));
          const [chainId, receipt] = await Promise.all([pub.getChainId(), receiptOrNull(pub, current.approvalHash)]);
          if (chainId !== current.chainId) throw new Error(clientTranslator("bridge")("errors.sourceRpcNetworkAgain"));
          fresh = { createdAt, receiptFound: receipt !== null, observedAt: Date.now() };
          setApprovalObservation(fresh);
        }
        if (!approvalCanDiscard(current, fresh, Date.now())) throw new Error(clientTranslator("bridge")("errors.approvalKept"));
        approvals.remove(address);
        setApprovalObservation(null);
        setApprovalIssue(null);
        invalidateQuote();
      });
    } catch (error) {
      setApprovalIssue({ key: address.toLowerCase(), message: messageOf(error, clientTranslator("bridge")("errors.approvalDiscardFailed")) });
    } finally {
      setDiscarding(false);
    }
  }

  const retryStatus = useCallback(() => setPollRevision((value) => value + 1), []);
  const retryApproval = useCallback(() => setApprovalPollRevision((value) => value + 1), []);
  const activePhase = activity.key === requestKey ? activity.phase : "idle";
  const quoteLoading = activePhase === "quoting" || (autoQuoteEnabled && !quote && !currentQuoteIssue);
  const phase: BridgePhase = sending && (activePhase === "switching" || activePhase === "confirming") ? activePhase : tracked ? transferPhase(tracked) : activePhase === "quoting" ? "quoting" : quote ? "review" : "idle";
  return {
    address, walletChainId, originChainId, destinationChainId, originAsset, destinationAsset, setOriginAsset, setDestinationAsset, setOriginChainId, setDestinationChainId, reverseRoute, amount, setAmount,
    balance: inputIsToken ? tokenBalance.data : sourceBalance.data?.value,
    nativeBalance: sourceBalance.data?.value,
    balanceLoading: !!address && (inputIsToken ? tokenBalance.isPending : sourceBalance.isPending),
    balanceError: (inputIsToken ? tokenBalance.isError : sourceBalance.isError) ? t("errors.balanceUnreadable") : null,
    quote, phase, error: tracked?.failureReason === "source-reverted" ? t("errors.sourceReverted") : issue?.key === walletKey ? issue.message : null,
    quoteError: currentQuoteIssue?.message ?? null,
    quoteRejection: currentQuoteIssue?.rejection ?? null,
    quoteLoading, canQuote: !!request,
    quoteExpired, requestQuote, confirm, reset, tracked,
    approval, approvalRequired, allowanceLoading, approvalBusy: approvalSending,
    approvalHealth: approvalPending && approvalHealthResult?.wallet === walletKey && approvalHealthResult.createdAt === approvalId && approvalHealthResult.hash === approvalHash ? approvalHealthResult.value : null,
    approvalError: approvalIssue?.key === walletKey ? approvalIssue.message : quote && allowanceResult?.key === quote.requestId ? allowanceResult.error : null,
    approve, retryApproval, recoverApproval, approvalCanBeDiscarded, discardApproval,
    canDiscard, discard, discarding,
    statusError: statusIssue && statusIssue.key === trackedId ? statusIssue.message : null,
    retryStatus, storageError, busy: sending || approvalSending || approvalPending,
    canReset: !sending && !approvalSending && !approvalPending && (!tracked || transferIsTerminal(tracked)),
  };
}

export default useBridge;
