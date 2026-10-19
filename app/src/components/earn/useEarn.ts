"use client";

import { useEffect, useRef, useState } from "react";
import { useBalance, useConfig, useReadContract, useReadContracts, useSwitchChain } from "wagmi";
import { getAccount, getCallsStatus, getCapabilities, getPublicClient, getWalletClient, sendCalls, waitForCallsStatus } from "wagmi/actions";
import type { Address, Hex, PublicClient } from "viem";
import { useHydratedAccount } from "@/lib/useHydratedAccount";
import { BUILDER_DATA_SUFFIX, CHAINS } from "@/lib/chainPublic";
import { ERC20_MIN_ABI } from "@/lib/launchpad/abi";
import { EARN_VAULT_ABI } from "@/lib/earn/abi";
import { BATCH_FAILED, EARN_BATCH_CAPABILITIES, approveCall, approvedState, batchHash, canBatch, depositCall, redeemCall, withdrawCall, type EarnCall } from "@/lib/earn/calls";
import { cleanAmountInput, depositProblem, fmtAmount, maxInput, parseAmount, withdrawPlan, withdrawProblem } from "@/lib/earn/math";
import { NOT_CONFIRMED_YET, isBusy, revertedCopy, type EarnOutcome, type EarnPhase, type EarnSent, type EarnTab } from "@/lib/earn/phase";
import { liveCheck, pausedCopy, readTerms, termsCheck } from "@/lib/earn/terms";
import type { EarnVault } from "@/lib/earn/vaults";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/components/launchpad/TxToasts";

export type { EarnPhase, EarnTab } from "@/lib/earn/phase";

/**
 * Earn's state and its two actions, for one vault and the connected wallet.
 *
 * Reads (balance, allowance, shares, what the shares redeem for) go through the same-origin RPC proxy like every other
 * read in the app. Writes follow TradePanel: a synchronous lock before the first await, a network switch if needed, a
 * simulation before every signature, then the receipt. Every write is credited to openlaunch's builder code
 * (lib/earn/calls.ts): one-at-a-time wallets via `dataSuffix`, batching smart wallets via `sendCalls` with the suffix on
 * each call and as the `dataSuffix` capability. Approvals are for the exact amount, never unlimited.
 *
 * Every wallet prompt is bound to the account that started the action and preceded by a check that it is still the
 * connected one. Once something is sent, only a final answer ends the action: a receipt that cannot be read leaves it
 * "unconfirmed" (lib/earn/phase.ts) with a "Check again", never retryable.
 */

/** A wallet switch mid-action: stop before the next prompt, whatever the new account is. */
const ACCOUNT_CHANGED = "Your wallet switched accounts, so this stopped before anything else was sent. Start again from the account you want to use.";
/** The card went away mid-action (the page changed): stop before the next prompt. */
const FLOW_STOPPED = "Stopped: the Earn card closed before the next step.";

/** The wallet's USDC, its vault shares and what they redeem for now. Shared by the /me card and the dialog. */
export function useEarnPosition(vault: EarnVault, address: Address | undefined) {
  const chainId = CHAINS[vault.chain].id;
  const on = Boolean(address);
  const usdc = useReadContract({ address: vault.asset, abi: ERC20_MIN_ABI, functionName: "balanceOf", args: address ? [address] : undefined, chainId, query: { enabled: on, refetchInterval: 15_000 } });
  const shares = useReadContract({ address: vault.address, abi: EARN_VAULT_ABI, functionName: "balanceOf", args: address ? [address] : undefined, chainId, query: { enabled: on, refetchInterval: 15_000 } });
  const held = shares.data;
  const redeem = useReadContract({ address: vault.address, abi: EARN_VAULT_ABI, functionName: "previewRedeem", args: held !== undefined ? [held] : undefined, chainId, query: { enabled: on && held !== undefined && held > 0n, refetchInterval: 15_000 } });
  const allowance = useReadContract({ address: vault.asset, abi: ERC20_MIN_ABI, functionName: "allowance", args: address ? [address, vault.address] : undefined, chainId, query: { enabled: on, refetchInterval: 15_000 } });
  return {
    balance: usdc.data,
    shares: held,
    /** What every share redeems for right now (0 with no shares, undefined while reading). */
    position: held === undefined ? undefined : held === 0n ? 0n : redeem.data,
    allowance: allowance.data,
    unreadable: Boolean(usdc.error || shares.error || redeem.error),
    refetch: () => Promise.all([usdc.refetch(), shares.refetch(), redeem.refetch(), allowance.refetch()]),
  };
}

/** Earn's form state, its reads and its two actions for one vault and the connected wallet (see the file comment). */
export default function useEarn(vault: EarnVault, initialTab: EarnTab) {
  const config = useConfig();
  const chainId = CHAINS[vault.chain].id;
  const { address, isConnected, chainId: walletChain } = useHydratedAccount();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const position = useEarnPosition(vault, address);
  const gas = useBalance({ address, chainId, query: { enabled: Boolean(address), refetchInterval: 30_000 } });
  const [tab, setTabState] = useState<EarnTab>(initialTab);
  const [text, setText] = useState("");
  // "Withdraw all" stays all even as interest grows the position after the tap, so no dust share is left behind
  const [all, setAll] = useState(false);
  const [phase, setPhase] = useState<EarnPhase>({ k: "idle" });
  const lock = useRef(false);
  // false once the card unmounts (wallet switched, page left): an action in flight stops before its next wallet prompt
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The vault's terms, re-read every minute while the card is open (one multicall). The pause is derived from this on
  // every render (lib/earn/terms.ts depositPause), never stored, so it lifts by itself when the terms are back.
  const at = { address: vault.address, abi: EARN_VAULT_ABI, chainId } as const;
  const terms = useReadContracts({
    contracts: [
      { ...at, functionName: "asset" },
      { ...at, functionName: "performanceFee" },
      { ...at, functionName: "managementFee" },
      { ...at, functionName: "receiveSharesGate" },
      { ...at, functionName: "sendSharesGate" },
      { ...at, functionName: "receiveAssetsGate" },
      { ...at, functionName: "sendAssetsGate" },
    ],
    allowFailure: false,
    query: { refetchInterval: 60_000 },
  });
  // a failed latest poll means no live answer: the server's check stands instead of an older live one
  const liveTerms = liveCheck(vault, terms.data, terms.isError);

  const decimals = vault.assetDecimals;
  const typed = parseAmount(text, decimals);
  const amount = tab === "withdraw" && all ? (position.position ?? null) : typed;
  const busy = isBusy(phase);
  const onChain = walletChain === chainId;
  const problem = tab === "deposit" ? depositProblem({ amount, balance: position.balance }) : withdrawProblem({ amount, shares: position.shares, position: position.position });
  const needsApproval = tab === "deposit" && amount !== null && position.allowance !== undefined ? position.allowance < amount : null;

  /** An edit clears a finished or failed result, so the form reads fresh. */
  const settle = () => { if (phase.k === "done" || phase.k === "error") setPhase({ k: "idle" }); };
  /** Switches between Deposit and Withdraw with an empty amount; ignored while a transaction is in flight. */
  function setTab(next: EarnTab) {
    if (busy) return;
    setTabState(next);
    setText("");
    setAll(false);
    settle();
  }
  /** The amount field's text, cleaned (lib/earn/math.ts cleanAmountInput); typing ends a "withdraw all". */
  function setAmount(raw: string) {
    setText(cleanAmountInput(raw, decimals));
    setAll(false);
    settle();
  }
  /** Max: the whole wallet balance on Deposit; on Withdraw, the whole position as "withdraw all". */
  function setMax() {
    if (tab === "deposit") setText(maxInput(position.balance ?? 0n, decimals));
    else {
      setText(maxInput(position.position ?? 0n, decimals));
      setAll(true);
    }
    settle();
  }

  /**
   * The explicit "Switch to Base" step, before the form offers to send anything. Never while a send is in flight or
   * unsettled, and a rejection that lands late can never replace such a state: it would unlock the form while a
   * deposit may still go through.
   */
  async function switchToVaultChain() {
    if (busy || lock.current) return;
    try {
      await switchChainAsync({ chainId });
    } catch (err) {
      setPhase((current) => (isBusy(current) ? current : { k: "error", message: friendlyError(err) }));
    }
  }

  /**
   * Throws unless the account that started the action is still the connected one and the card is still mounted. Runs
   * before every wallet prompt, so a switch to another account mid-action never sends that account a prompt meant for
   * this one (the keyed remount on a switch does not cancel an async action already running).
   */
  function ensureAccount(account: Address) {
    if (!mounted.current) throw new Error(FLOW_STOPPED);
    const current = getAccount(config).address;
    if (!current || current.toLowerCase() !== account.toLowerCase()) throw new Error(ACCOUNT_CHANGED);
  }

  /** The wallet client for exactly this account (wagmi refuses if the connector no longer has it). */
  async function walletFor(account: Address) {
    ensureAccount(account);
    return getWalletClient(config, { chainId, account });
  }

  /**
   * Whether this wallet already executes atomic batches; an unreadable answer means the one-at-a-time path. A changed
   * account is not an unreadable answer: it stops the action.
   */
  async function batching(account: Address): Promise<boolean> {
    ensureAccount(account);
    try {
      return canBatch(await getCapabilities(config, { account, chainId }));
    } catch {
      ensureAccount(account);
      return false;
    }
  }

  /** Stops a deposit when the live vault differs from the reviewed terms; the form shows the pause at once. */
  async function requireTerms(pub: Pick<PublicClient, "readContract">) {
    const check = termsCheck(vault, await readTerms(pub, vault));
    if (!check.ok) {
      void terms.refetch(); // the form shows the pause now, not at the next poll
      throw new Error(pausedCopy(check.reason));
    }
  }

  /**
   * Simulates the whole deposit batch before the wallet's one prompt, the way the batch will run: the approval, then
   * the deposit with that approval's only effect (the allowance) applied as a state override on the asset. Returns
   * false when the override does not take (the asset's storage is not what was reviewed): the caller then takes the
   * one-at-a-time path, where each call is simulated on its own. A deposit that reverts with the allowance in place
   * throws here, before any prompt.
   */
  async function preflightBatch(pub: Pick<PublicClient, "simulateContract" | "readContract">, account: Address, value: bigint, withApproval: boolean): Promise<boolean> {
    if (!withApproval) {
      await pub.simulateContract({ address: vault.address, abi: EARN_VAULT_ABI, functionName: "deposit", args: [value, account], account, dataSuffix: BUILDER_DATA_SUFFIX });
      return true;
    }
    await pub.simulateContract({ address: vault.asset, abi: ERC20_MIN_ABI, functionName: "approve", args: [vault.address, value], account, dataSuffix: BUILDER_DATA_SUFFIX });
    const stateOverride = approvedState(vault, account, value);
    const seen = await pub.readContract({ address: vault.asset, abi: ERC20_MIN_ABI, functionName: "allowance", args: [account, vault.address], stateOverride }).catch(() => null);
    if (seen !== value) return false;
    await pub.simulateContract({ address: vault.address, abi: EARN_VAULT_ABI, functionName: "deposit", args: [value, account], account, dataSuffix: BUILDER_DATA_SUFFIX, stateOverride });
    return true;
  }

  /** The state for a send whose outcome could not be read. */
  function unconfirmed(tab: EarnTab, amount: bigint, sent: EarnSent): EarnPhase {
    return { k: "unconfirmed", tab, amount, sent, checking: false, note: null };
  }

  /** Waits for a sent transaction. A receipt decides; a timeout or RPC error leaves it unconfirmed, not failed. */
  async function settleTx(pub: Pick<PublicClient, "waitForTransactionReceipt">, hash: Hex, tab: EarnTab, amount: bigint): Promise<EarnOutcome> {
    let rc;
    try {
      rc = await pub.waitForTransactionReceipt({ hash });
    } catch {
      setPhase(unconfirmed(tab, amount, { kind: "tx", hash }));
      return { confirmed: false };
    }
    if (rc.status !== "success") throw new Error(revertedCopy(tab));
    return { confirmed: true, hash };
  }

  /** Sends through the wallet's batch API with the builder-code capability, then waits for the wallet's final status. */
  async function sendBatch(account: Address, calls: EarnCall[], tab: EarnTab, amount: bigint): Promise<EarnOutcome> {
    ensureAccount(account);
    setPhase({ k: "signing" });
    const { id } = await sendCalls(config, { account, chainId, calls, capabilities: EARN_BATCH_CAPABILITIES, forceAtomic: true });
    setPhase({ k: "sent", hash: null });
    let result;
    try {
      result = await waitForCallsStatus(config, { id, timeout: 180_000 });
    } catch {
      setPhase(unconfirmed(tab, amount, { kind: "batch", id }));
      return { confirmed: false };
    }
    return { confirmed: true, hash: batchHash(result) };
  }

  /** A confirmed action: the done state, a toast, a clean form and fresh balances. */
  function finish(tab: EarnTab, amount: bigint, hash: Hex | null) {
    setPhase({ k: "done", hash, tab, amount });
    toast({ kind: "info", title: `${tab === "deposit" ? "Deposited" : "Withdrew"} ${fmtAmount(amount, decimals)} ${vault.assetSymbol}`, sub: `${tab === "deposit" ? "Into" : "From"} ${vault.name}` });
    setText("");
    setAll(false);
    void position.refetch();
  }

  /** Deposits the amount: fresh terms and balance checks, an exact approval only if short, terms again, simulate, send. */
  async function deposit() {
    if (!address || amount === null || problem || busy || lock.current) return;
    // Lock before the first await, including the network switch and the vault check.
    lock.current = true;
    const account = address;
    const value = amount;
    setPhase({ k: "preparing" });
    try {
      if (!onChain) await switchChainAsync({ chainId });
      const pub = getPublicClient(config, { chainId })!;
      // authoritative: read fresh at send time, whatever the polled terms said
      await requireTerms(pub);
      const [balance, allowance] = await Promise.all([
        pub.readContract({ address: vault.asset, abi: ERC20_MIN_ABI, functionName: "balanceOf", args: [account] }),
        pub.readContract({ address: vault.asset, abi: ERC20_MIN_ABI, functionName: "allowance", args: [account, vault.address] }),
      ]);
      if (value > balance) throw new Error("That is more USDC than this wallet holds.");
      const short = allowance < value;
      let outcome: EarnOutcome;
      // one prompt for a wallet that batches, once the whole batch has simulated; atomic, so a failed deposit takes the
      // approval back with it
      if ((await batching(account)) && (await preflightBatch(pub, account, value, short))) {
        outcome = await sendBatch(account, short ? [approveCall(vault, value), depositCall(vault, value, account)] : [depositCall(vault, value, account)], "deposit", value);
      } else {
        if (short) {
          const wallet = await walletFor(account);
          setPhase({ k: "approving" });
          const approval = await wallet.writeContract({ account, address: vault.asset, abi: ERC20_MIN_ABI, functionName: "approve", args: [vault.address, value], dataSuffix: BUILDER_DATA_SUFFIX });
          // approving again is harmless (it sets the same exact allowance), so an unreadable approval may be retried
          const rc = await pub.waitForTransactionReceipt({ hash: approval }).catch(() => {
            throw new Error("The approval's confirmation could not be read. Nothing was deposited; try again (an approval that went through is reused).");
          });
          if (rc.status !== "success") throw new Error("The approval reverted on-chain. Nothing was deposited.");
          // the vault could have changed while the approval confirmed
          await requireTerms(pub);
        }
        const { request } = await pub.simulateContract({ address: vault.address, abi: EARN_VAULT_ABI, functionName: "deposit", args: [value, account], account, dataSuffix: BUILDER_DATA_SUFFIX });
        const wallet = await walletFor(account);
        setPhase({ k: "signing" });
        const hash = await wallet.writeContract(request);
        setPhase({ k: "sent", hash });
        outcome = await settleTx(pub, hash, "deposit", value);
      }
      if (outcome.confirmed) finish("deposit", value, outcome.hash);
    } catch (err) {
      setPhase({ k: "error", message: friendlyError(err) });
    } finally {
      lock.current = false;
    }
  }

  /** Withdraws per withdrawPlan: every share for "withdraw all", else exactly the amount; simulate, send, receipt. */
  async function withdraw() {
    const plan = withdrawPlan({ amount, shares: position.shares, position: position.position });
    if (!address || !plan || problem || busy || lock.current) return;
    lock.current = true;
    const account = address;
    setPhase({ k: "preparing" });
    try {
      if (!onChain) await switchChainAsync({ chainId });
      const pub = getPublicClient(config, { chainId })!;
      // "withdraw all" redeems the shares held at this moment, not the count from the last poll
      const held = await pub.readContract({ address: vault.address, abi: EARN_VAULT_ABI, functionName: "balanceOf", args: [account] });
      if (held <= 0n) throw new Error("Nothing is deposited from this wallet.");
      let outcome: EarnOutcome;
      if (await batching(account)) {
        // the one call, simulated before the one prompt
        if (plan.fn === "redeem") await pub.simulateContract({ address: vault.address, abi: EARN_VAULT_ABI, functionName: "redeem", args: [held, account, account], account, dataSuffix: BUILDER_DATA_SUFFIX });
        else await pub.simulateContract({ address: vault.address, abi: EARN_VAULT_ABI, functionName: "withdraw", args: [plan.assets, account, account], account, dataSuffix: BUILDER_DATA_SUFFIX });
        outcome = await sendBatch(account, [plan.fn === "redeem" ? redeemCall(vault, held, account) : withdrawCall(vault, plan.assets, account)], "withdraw", plan.assets);
      } else {
        let hash: Hex;
        if (plan.fn === "redeem") {
          const { request } = await pub.simulateContract({ address: vault.address, abi: EARN_VAULT_ABI, functionName: "redeem", args: [held, account, account], account, dataSuffix: BUILDER_DATA_SUFFIX });
          const wallet = await walletFor(account);
          setPhase({ k: "signing" });
          hash = await wallet.writeContract(request);
        } else {
          const { request } = await pub.simulateContract({ address: vault.address, abi: EARN_VAULT_ABI, functionName: "withdraw", args: [plan.assets, account, account], account, dataSuffix: BUILDER_DATA_SUFFIX });
          const wallet = await walletFor(account);
          setPhase({ k: "signing" });
          hash = await wallet.writeContract(request);
        }
        setPhase({ k: "sent", hash });
        outcome = await settleTx(pub, hash, "withdraw", plan.assets);
      }
      if (outcome.confirmed) finish("withdraw", plan.assets, outcome.hash);
    } catch (err) {
      setPhase({ k: "error", message: friendlyError(err) });
    } finally {
      lock.current = false;
    }
  }

  /** "Check again" on an unconfirmed send: only a receipt, or the wallet's final batch status, ends it. */
  async function recheck() {
    if (phase.k !== "unconfirmed" || phase.checking || lock.current) return;
    const p = phase;
    lock.current = true;
    setPhase({ ...p, checking: true, note: null });
    try {
      if (p.sent.kind === "tx") {
        const pub = getPublicClient(config, { chainId })!;
        const rc = await pub.getTransactionReceipt({ hash: p.sent.hash }).catch(() => null);
        if (!rc) setPhase({ ...p, checking: false, note: NOT_CONFIRMED_YET });
        else if (rc.status !== "success") setPhase({ k: "error", message: revertedCopy(p.tab) });
        else finish(p.tab, p.amount, p.sent.hash);
      } else {
        const status = await getCallsStatus(config, { id: p.sent.id }).catch(() => null);
        // only "success" or "failure" is final; no answer, "pending" or anything else keeps it unconfirmed.
        // A success whose receipts include a revert makes batchHash throw: an error too, never done.
        if (status?.status === "success") finish(p.tab, p.amount, batchHash(status));
        else if (status?.status === "failure") setPhase({ k: "error", message: BATCH_FAILED });
        else setPhase({ ...p, checking: false, note: NOT_CONFIRMED_YET });
      }
    } catch (err) {
      setPhase({ k: "error", message: friendlyError(err) });
    } finally {
      lock.current = false;
    }
  }

  return {
    vault,
    address,
    isConnected,
    onChain,
    switching,
    tab,
    setTab,
    text,
    setAmount,
    setMax,
    all,
    amount,
    problem,
    needsApproval,
    /** The live vault against the reviewed terms; null until the first read lands, or while the latest read failed. */
    liveTerms,
    phase,
    busy,
    reset: () => { if (!busy) setPhase({ k: "idle" }); },
    recheck,
    balance: position.balance,
    shares: position.shares,
    position: position.position,
    unreadable: position.unreadable,
    noGas: gas.data !== undefined && gas.data.value === 0n,
    switchToVaultChain,
    submit: () => (tab === "deposit" ? deposit() : withdraw()),
  };
}

export type Earn = ReturnType<typeof useEarn>;
