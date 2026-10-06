"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useBalance, useConfig, useReadContract, useSwitchChain } from "wagmi";
import { useHydratedAccount } from "@/lib/useHydratedAccount";
import { getPublicClient, getWalletClient } from "wagmi/actions";
import { formatEther, formatUnits, maxUint160, maxUint256, parseUnits, type Address, type Hex } from "viem";
import { ArrowDown, ArrowRight, Wallet } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/vendor/toggle-group";
import { btn } from "@/components/ui";
import { toast } from "./TxToasts";
import { ERC20_MIN_ABI, PERMIT2_ABI, STATE_VIEW_ABI, UNIVERSAL_ROUTER_ABI, V4_QUOTER_ABI } from "@/lib/launchpad/abi";
import { fmtImpact, impactLevel, priceImpact } from "@/lib/launchpad/price-impact";
import { BUY_PRESETS, NATIVE, SWAP_GAS_RESERVE_WEI, launchpad, quoteUsdOf, sharesGasBalance, type Quote } from "@/lib/launchpad/config";
import { TWIG_WRAP_URL } from "@/lib/launchpad/twig";
import { gasReserveInQuote } from "@/lib/launchpad/first-buy";
import { fmtCompact, fmtQuoteUnits, fmtUsd, minOut, units } from "@/lib/launchpad/math";
import { sanitizeDecimalInput } from "@/lib/launchpad/decimal-input";
import { encodeV4ExactInSingle, type PoolKey } from "@/lib/launchpad/swap";
import { CHAINS, CHAIN_LABELS, BUILDER_DATA_SUFFIX, explorerAddress, explorerTx, shortAddr, type ChainKey } from "@/lib/chainPublic";
import { tradeQuoteKey } from "@/lib/launchpad/token-market";
import { SLIPPAGE_PRESETS_BPS, formatSlippageBps, getSlippageBps, getSlippageBpsServer, parseSlippageField, setSlippageBps, subscribeSlippage } from "@/lib/launchpad/trade-slippage";
import { friendlyError } from "@/lib/errors";
import { Spinner } from "@/components/Skeleton";
import ConnectWallet from "@/components/ConnectWallet";
import { ChainLogo } from "./ChainLogo";

/**
 * In-page buy / sell straight against the token's Uniswap v4 pool via the
 * Universal Router (V4_SWAP). Buys send the native asset as value; sells go through Permit2
 * (one-time ERC-20 approve to Permit2, then a 30-day Permit2 allowance to the
 * router). Quotes come from the V4 Quoter with a 400ms debounce; every send is
 * simulated first so reverts surface before a signature.
 */
type Side = "buy" | "sell";
type Phase =
  | { k: "idle" }
  | { k: "preparing" }
  | { k: "approving"; step: "erc20" | "permit2" }
  | { k: "signing" }
  | { k: "sent"; hash: Hex }
  | { k: "done"; hash: Hex; side: Side }
  | { k: "error"; message: string };

const PERMIT_EXPIRY_S = 30 * 24 * 3600;


export default function TradePanel({ chain, token, symbol, poolKey, poolId, feeRoute, quote, ethUsd, onTraded }: { chain: ChainKey; token: Address; symbol: string; poolKey: PoolKey; poolId: Hex; feeRoute: string; quote: Quote; ethUsd: number | null; onTraded?: () => void }) {
  const CHAIN = CHAINS[chain];
  const CHAIN_LABEL = CHAIN_LABELS[chain];
  const V4 = launchpad(chain).v4;
  const configured = launchpad(chain).configured;
  // An unlisted quote (any ERC-20 the factory was handed) trades like any ERC-20 quote, once its decimals are known:
  // until then every amount would be scaled wrong, so the panel shows but does not send.
  const unlisted = quote.key === "other";
  const tradable = quote.decimalsKnown !== false;
  const isNative = quote.address.toLowerCase() === NATIVE; // the native asset, whatever the chain calls it (ETH, or USDC on Arc)
  // A buy paid from the gas balance (the native asset, or on Arc the USDC quote that is its ERC-20 face) keeps the swap's gas back,
  // in the quote's own units; a buy paid in any other ERC-20 does not touch the gas balance
  const buyReserve = isNative || sharesGasBalance(chain, quote) ? gasReserveInQuote(SWAP_GAS_RESERVE_WEI[chain], quote.decimals) : 0n;
  const NATIVE_SYMBOL = CHAIN.nativeCurrency.symbol;
  const quoteUsd = quoteUsdOf(quote, ethUsd);
  const fmtQ = (raw: bigint) => `${fmtQuoteUnits(units(raw, quote.decimals), quote.decimals)} ${quote.symbol}`;
  const router = useRouter();
  const config = useConfig();
  const { address, isConnected, chainId } = useHydratedAccount();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  // Stored slippage via an external store: the server snapshot is always the default, so server and
  // client render the same markup during hydration (an effect that sets state is rejected by lint).
  const getSlippageSnapshot = useMemo(() => () => getSlippageBps(chain), [chain]);
  const slippageBps = useSyncExternalStore(subscribeSlippage, getSlippageSnapshot, getSlippageBpsServer);
  const [slippageInput, setSlippageInput] = useState<string | null>(null);
  const [slippageError, setSlippageError] = useState<string | null>(null);
  // `sqrtPriceX96` is the pool's spot price read beside the quote (null if StateView could not answer): it gives price impact
  const [quote_, setQuote] = useState<{ out: bigint; forKey: string; sqrtPriceX96: bigint | null } | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  // a trade that moves the price past IMPACT_CONFIRM takes a second tap; this holds the quote the first tap armed
  const [armed, setArmed] = useState<string | null>(null);
  const [sellAll, setSellAll] = useState<{ forBalance: string; out: bigint; impact: number | null } | null>(null);
  const seq = useRef(0);
  const transactionLock = useRef(false);

  const eth = useBalance({ address, chainId: CHAIN.id, query: { enabled: Boolean(address) && isNative, refetchInterval: 15_000 } });
  const qbal = useReadContract({ address: quote.address, abi: ERC20_MIN_ABI, functionName: "balanceOf", args: address ? [address] : undefined, chainId: CHAIN.id, query: { enabled: Boolean(address) && !isNative, refetchInterval: 15_000 } });
  const tok = useReadContract({ address: token, abi: ERC20_MIN_ABI, functionName: "balanceOf", args: address ? [address] : undefined, chainId: CHAIN.id, query: { enabled: Boolean(address), refetchInterval: 15_000 } });

  const amountIn = useMemo(() => {
    try {
      if (!amount.trim() || Number(amount) <= 0) return null;
      return side === "buy" ? parseUnits(amount, quote.decimals) : parseUnits(amount, 18);
    } catch {
      return null;
    }
  }, [amount, side, quote.decimals]);

  const onChain = chainId === CHAIN.id;
  const busy = phase.k === "preparing" || phase.k === "approving" || phase.k === "signing" || phase.k === "sent";
  const balance = side === "buy" ? (isNative ? eth.data?.value : (qbal.data as bigint | undefined)) : (tok.data as bigint | undefined);
  const insufficient = amountIn !== null && balance !== undefined && amountIn + (side === "buy" ? buyReserve : 0n) > balance;

  const quoteKey = tradeQuoteKey(chain, token, side, amount);
  // A response can only be used for the exact chain/token/side/amount requested.
  useEffect(() => {
    const my = ++seq.current;
    if (amountIn === null) return;
    const quoter = V4.quoter;
    const t = setTimeout(async () => {
      setQuoting(true);
      try {
        const pub = getPublicClient(config, { chainId: CHAIN.id })!;
        const [{ result }, sqrtPriceX96] = await Promise.all([
          pub.simulateContract({
            address: quoter,
            abi: V4_QUOTER_ABI,
            functionName: "quoteExactInputSingle",
            args: [{ poolKey, zeroForOne: side === "buy", exactAmount: amountIn, hookData: "0x" }],
          }),
          pub.readContract({ address: V4.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [poolId] }).then((slot0) => slot0[0] as bigint, () => null),
        ]);
        if (my === seq.current) setQuote({ out: result[0], forKey: quoteKey, sqrtPriceX96 });
      } catch {
        if (my === seq.current) setQuote(null);
      } finally {
        if (my === seq.current) setQuoting(false);
      }
    }, 400);
    return () => { clearTimeout(t); seq.current = my + 1; };
  }, [amountIn, side, poolKey, poolId, config, amount, V4.quoter, V4.stateView, CHAIN.id, quoteKey]);

  // What selling the whole position would return right now, re-quoted whenever the balance changes
  const tokenBalance = tok.data as bigint | undefined;
  useEffect(() => {
    if (!address || !tradable || tokenBalance === undefined || tokenBalance <= 0n) return;
    let active = true;
    const t = setTimeout(async () => {
      try {
        const pub = getPublicClient(config, { chainId: CHAIN.id })!;
        const [{ result }, sqrtPriceX96] = await Promise.all([
          pub.simulateContract({ address: V4.quoter, abi: V4_QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{ poolKey, zeroForOne: false, exactAmount: tokenBalance, hookData: "0x" }] }),
          pub.readContract({ address: V4.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [poolId] }).then((slot0) => slot0[0] as bigint, () => null),
        ]);
        const impact = sqrtPriceX96 === null ? null : priceImpact({ sqrtPriceX96, amountIn: tokenBalance, amountOut: result[0], zeroForOne: false, feePips: poolKey.fee });
        if (active) setSellAll({ forBalance: tokenBalance.toString(), out: result[0], impact });
      } catch {
        if (active) setSellAll(null);
      }
    }, 600);
    return () => { active = false; clearTimeout(t); };
  }, [address, tradable, tokenBalance, poolKey, poolId, config, V4.quoter, V4.stateView, CHAIN.id]);

  async function trade() {
    if (!tradable || !address || amountIn === null || !quote_ || quote_.forKey !== quoteKey || busy || insufficient || transactionLock.current) return;
    // Lock before the first await, including wallet lookup and RPC preflight.
    transactionLock.current = true;
    setPhase({ k: "preparing" });
    // Declared here so catch can use it; assigned after preflight so the
    // synchronous lock/preparing prefix stays dependency-free for the safety
    // harness. Null means preflight failed before the tolerance was read —
    // those errors are never slippage reverts, so the default applies.
    let tradeSlippageBps: number | null = null;
    try {
      if (!onChain) await switchChainAsync({ chainId: CHAIN.id });
      const pub = getPublicClient(config, { chainId: CHAIN.id })!;
      const wallet = await getWalletClient(config, { chainId: CHAIN.id });
      // The closure value is fixed per render, so mid-flight preset picks in a
      // newer render cannot change this transaction's tolerance either way.
      tradeSlippageBps = slippageBps;
      const min = minOut(quote_.out, tradeSlippageBps);

      // Whatever ERC20 we are paying with (the token on a sell, an ERC20 quote on a buy) goes through Permit2.
      const payToken: Address | null = side === "sell" ? token : isNative ? null : quote.address;
      if (payToken) {
        const erc20Allowance = await pub.readContract({ address: payToken, abi: ERC20_MIN_ABI, functionName: "allowance", args: [address, V4.permit2] });
        if (erc20Allowance < amountIn) {
          setPhase({ k: "approving", step: "erc20" });
          const h = await wallet.writeContract({ address: payToken, abi: ERC20_MIN_ABI, functionName: "approve", args: [V4.permit2, maxUint256], dataSuffix: BUILDER_DATA_SUFFIX });
          await pub.waitForTransactionReceipt({ hash: h });
        }
        const [pAmount, pExp] = await pub.readContract({ address: V4.permit2, abi: PERMIT2_ABI, functionName: "allowance", args: [address, payToken, V4.universalRouter] });
        const now = Math.floor(Date.now() / 1000);
        if (pAmount < amountIn || pExp <= now + 60) {
          setPhase({ k: "approving", step: "permit2" });
          const h = await wallet.writeContract({
            address: V4.permit2,
            abi: PERMIT2_ABI,
            functionName: "approve",
            args: [payToken, V4.universalRouter, maxUint160, now + PERMIT_EXPIRY_S],
            dataSuffix: BUILDER_DATA_SUFFIX,
          });
          await pub.waitForTransactionReceipt({ hash: h });
        }
      }

      const { commands, inputs } = encodeV4ExactInSingle({ key: poolKey, zeroForOne: side === "buy", amountIn, minOut: min, layout: V4.swapLayout });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const { request } = await pub.simulateContract({
        address: V4.universalRouter,
        abi: UNIVERSAL_ROUTER_ABI,
        functionName: "execute",
        args: [commands, inputs, deadline],
        value: side === "buy" && isNative ? amountIn : 0n,
        account: address,
        dataSuffix: BUILDER_DATA_SUFFIX,
      });
      setPhase({ k: "signing" });
      const hash = await wallet.writeContract(request);
      setPhase({ k: "sent", hash });
      const rc = await pub.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") throw new Error("Transaction reverted on-chain.");
      await fetch(`/api/launch/sync?chain=${chain}&tx=${hash}`, { method: "POST" }).catch(() => {});
      setPhase({ k: "done", hash, side });
      toast({ kind: side, title: side === "buy" ? `You bought ${quote_ ? fmtCompact(Number(quote_.out) / 1e18) : ""} ${symbol}` : `You sold ${fmtCompact(Number(amountIn) / 1e18)} ${symbol}`, sub: `Confirmed on ${CHAIN_LABEL}`, chain, token, symbol, celebrate: side === "buy" });
      setAmount("");
      setQuote(null);
      void eth.refetch();
      void qbal.refetch();
      void tok.refetch();
      onTraded?.();
      router.refresh();
    } catch (err) {
      setPhase({ k: "error", message: friendlyError(err, tradeSlippageBps !== null ? { slippagePct: tradeSlippageBps / 100 } : {}) });
    } finally {
      transactionLock.current = false;
    }
  }

  const outLabel = quote_ && quote_.forKey === quoteKey ? (side === "buy" ? `${fmtCompact(Number(quote_.out) / 1e18)} ${symbol}` : fmtQ(quote_.out)) : null;
  const outUsd = quote_ && quote_.forKey === quoteKey && side === "sell" && quoteUsd ? fmtUsd(units(quote_.out, quote.decimals) * quoteUsd) : null;
  const inUsd = amountIn !== null && side === "buy" && quoteUsd ? fmtUsd(units(amountIn, quote.decimals) * quoteUsd) : null;
  const fresh = quote_ && quote_.forKey === quoteKey ? quote_ : null;
  const impact = fresh && fresh.sqrtPriceX96 !== null && amountIn !== null ? priceImpact({ sqrtPriceX96: fresh.sqrtPriceX96, amountIn, amountOut: fresh.out, zeroForOne: side === "buy", feePips: poolKey.fee }) : null;
  const level = impact === null ? null : impactLevel(impact);
  const confirming = level === "confirm" && armed === quoteKey;
  // the second tap is outside trade() on purpose: trade() keeps its synchronous lock as the first thing it does
  function onTrade() {
    if (level === "confirm" && armed !== quoteKey) { setArmed(quoteKey); return; }
    setArmed(null);
    void trade();
  }
  const sold = sellAll && tokenBalance !== undefined && tokenBalance > 0n && sellAll.forBalance === tokenBalance.toString() ? sellAll : null;

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-card scroll-mt-24" id="trade" tabIndex={-1} aria-label={`Trade ${symbol}`}>
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-line px-5"><h2 className="min-w-0 truncate text-sm font-semibold text-ink">Trade {symbol}</h2><span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-muted"><ChainLogo chain={chain} size={12} />{CHAIN_LABEL}</span></div>
      <div className="space-y-4 p-4 sm:p-5">
      <ToggleGroup aria-label="Trade side" value={[side]} onValueChange={(v) => { if (!v[0] || busy) return; setSide(v[0] as Side); setAmount(""); setQuote(null); setQuoting(false); setPhase({ k: "idle" }); }} className="grid w-full grid-cols-2">
        {(["buy", "sell"] as Side[]).map((s) => <ToggleGroupItem key={s} value={s} disabled={busy} thumbClassName={s === "buy" ? "bg-up-soft" : "bg-down-soft"} className={`min-h-10 text-sm font-semibold ${s === "buy" ? "data-pressed:text-up" : "data-pressed:text-down-ink"}`}>{s === "buy" ? "Buy" : "Sell"}</ToggleGroupItem>)}
      </ToggleGroup>

      {unlisted ? (
        <p role="note" className="rounded-xl border border-warm/30 bg-warm-soft px-3 py-2 text-[11px] leading-relaxed text-warm-ink text-pretty">
          <b>Unlisted pair.</b> Priced in {quote.symbol} (<a href={explorerAddress(chain, quote.address)} target="_blank" rel="noreferrer" className="font-code underline underline-offset-2">{shortAddr(quote.address)} ↗</a>), a token openlaunch does not list. Anyone can deploy a token with any name, so check that address before you trade. No USD price is shown.
        </p>
      ) : null}

      <div className="relative">
        {/* the pay well: amount, its token, the balance and quick amounts; the well itself shows the input's focus */}
        <div className="rounded-2xl border border-line bg-paper px-4 pb-3.5 pt-3 transition-[border-color,box-shadow] has-[input:focus-visible]:border-transparent has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-brand/60 motion-reduce:transition-none">
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted"><label htmlFor={`amount-${chain}-${token}`}>{side === "buy" ? "You pay" : "You sell"}</label>
            {balance !== undefined ? <button type="button" disabled={busy} className="-mr-1.5 inline-flex max-w-[65%] items-center gap-1 truncate rounded-md px-1.5 py-0.5 font-mono text-[10px] transition-colors hover:bg-ink/5 hover:text-ink motion-reduce:transition-none" title={`Use maximum available balance (reserve gas for ${NATIVE_SYMBOL})`} aria-label={`Use balance ${side === "buy" ? fmtQ(balance) : fmtCompact(Number(balance) / 1e18)}`} onClick={() => setAmount(side === "buy" ? formatUnits(balance > buyReserve ? balance - buyReserve : 0n, quote.decimals) : formatEther(balance))}><Wallet size={11} aria-hidden className="shrink-0" />{side === "buy" ? fmtQ(balance) : fmtCompact(Number(balance) / 1e18)}</button> : <Wallet size={12} aria-hidden />}
          </div>
          <div className="mt-1.5 flex items-center gap-3">
            <input id={`amount-${chain}-${token}`} disabled={busy} className="min-w-0 w-full bg-transparent py-1 font-mono text-[30px] leading-tight text-ink placeholder:text-faint focus-visible:outline-none! tnum" value={amount} onChange={(e) => setAmount(sanitizeDecimalInput(e.target.value))} placeholder="0.0" inputMode="decimal" autoComplete="off" aria-label={side === "buy" ? `${quote.symbol} amount` : `${symbol} amount`} />
            <span className="max-w-28 shrink-0 truncate rounded-full border border-line bg-card px-3 py-1.5 text-xs font-semibold text-ink">{side === "buy" ? quote.symbol : symbol}</span>
          </div>
          <div className="mt-3 flex gap-1.5">
            {side === "buy" ? BUY_PRESETS[quote.key].map((p) => <button key={p} type="button" disabled={busy} onClick={() => setAmount(p)} aria-label={`Pay ${p} ${quote.symbol}`} className={`min-h-7 flex-1 rounded-full border px-2 font-mono text-[11px] tnum transition-colors hover:border-line-strong hover:text-ink disabled:opacity-40 motion-reduce:transition-none ${amount === p ? "border-line-strong bg-card text-ink" : "border-line text-muted"}`}>{fmtQuoteUnits(Number(p), quote.decimals)}</button>) : [25, 50, 100].map((pct) => <button key={pct} type="button" disabled={busy || !balance} onClick={() => balance !== undefined && setAmount(formatEther((balance * BigInt(pct)) / 100n))} className="min-h-7 flex-1 rounded-full border border-line px-2 font-mono text-[11px] text-muted tnum transition-colors hover:border-line-strong hover:text-ink disabled:opacity-40 motion-reduce:transition-none">{pct === 100 ? "Max" : `${pct}%`}</button>)}
          </div>
        </div>
        {/* the arrow sits in a cut between the two wells, ringed in the card's own colour */}
        <div className="relative z-10 mx-auto -my-3.5 flex size-9 items-center justify-center rounded-full border-4 border-card bg-paper text-muted" aria-hidden><ArrowDown size={14} /></div>
        <div className="rounded-2xl border border-line bg-paper px-4 pb-3 pt-3.5">
          <div className="text-[11px] text-muted">You receive <span className="text-faint">· estimated</span></div>
          <div className="mt-1.5 flex min-h-9 items-center justify-between gap-3">
            <span className={`min-w-0 break-words font-mono text-[22px] font-bold leading-tight tnum ${outLabel ? "text-ink" : "text-faint"}`}>{outLabel ?? "—"}</span>{quoting && amountIn !== null ? <Spinner size={13} className="shrink-0 text-muted" /> : null}
          </div>
          <div className="mt-1 min-h-4 text-[10px] text-muted">{inUsd ?? outUsd ?? "Quote includes the pool trading fee."}</div>
        </div>
      </div>
      <dl className="space-y-2.5 px-1 text-[11px]">
        <div className="flex justify-between gap-3"><dt className="text-muted">Price impact</dt><dd className={`flex items-center gap-1.5 text-right font-mono tnum ${level === "warn" || level === "confirm" ? "text-warm-ink" : "text-body"}`}>{level === "warn" || level === "confirm" ? <span aria-hidden className="size-1.5 rounded-full bg-warm" /> : null}{impact === null ? "—" : fmtImpact(impact)}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted">Trading fee</dt><dd className="text-right text-body">{feeRoute}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted">Platform fee</dt><dd className="text-right font-mono text-up tnum">$0</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted">Minimum received</dt><dd className="text-right font-mono text-body tnum">{quote_ && quote_.forKey === quoteKey ? (side === "buy" ? `${fmtCompact(Number(minOut(quote_.out, slippageBps)) / 1e18)} ${symbol}` : fmtQ(minOut(quote_.out, slippageBps))) : "—"}</dd></div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted"><label htmlFor={`slippage-${chain}-${token}`}>Slippage tolerance</label></dt>
          <dd className="flex items-center gap-1.5">
            {/* a custom value that matches no preset leaves the presets unpressed */}
            <ToggleGroup aria-label="Slippage presets" value={SLIPPAGE_PRESETS_BPS.includes(slippageBps) ? [String(slippageBps)] : []} onValueChange={(values) => { const p = Number(values[0]); if (!values[0] || !Number.isFinite(p)) return; setSlippageBps(chain, p); setSlippageInput(null); setSlippageError(null); }} className="rounded-[9px] p-0.5">
              {SLIPPAGE_PRESETS_BPS.map((p) => <ToggleGroupItem key={p} value={String(p)} disabled={busy} aria-label={`Slippage ${formatSlippageBps(p)}`} className="min-h-6 rounded-[7px] px-2 font-mono text-[11px] tnum">{formatSlippageBps(p)}</ToggleGroupItem>)}
            </ToggleGroup>
            <span className="relative">
              <input
                id={`slippage-${chain}-${token}`}
                disabled={busy}
                className="h-7 w-16 rounded-md border border-line bg-transparent px-1.5 pr-5 text-right font-mono text-[11px] text-ink tnum outline-offset-2 placeholder:text-faint disabled:opacity-40"
                value={slippageInput ?? String(slippageBps / 100)}
                onChange={(e) => {
                  const raw = e.target.value;
                  setSlippageInput(raw);
                  const parsed = parseSlippageField(raw);
                  if (parsed === null) { setSlippageError(raw.trim() === "" ? null : "0.1–20%"); return; }
                  setSlippageError(null);
                  setSlippageBps(chain, parsed);
                }}
                onBlur={() => setSlippageInput(null)}
                inputMode="decimal"
                autoComplete="off"
                aria-label="Custom slippage percent"
                aria-describedby={slippageError ? `slippage-err-${chain}` : undefined}
              />
              <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted">%</span>
            </span>
          </dd>
        </div>
        {slippageError ? <p id={`slippage-err-${chain}`} role="alert" className="text-right text-[10px] text-down-ink">Use 0.1–20%.</p> : null}
      </dl>
      {level === "confirm" && impact !== null ? (
        <p role="note" className="rounded-xl border border-warm/30 bg-warm-soft px-3 py-2 text-[11px] leading-relaxed text-warm-ink text-pretty">
          This trade moves the price {fmtImpact(impact)}. New pools are thin, so a smaller amount can fill at a much better price. The button asks for a second tap.
        </p>
      ) : null}

      {!configured || !tradable ? (
        <button type="button" disabled className={`${btn.secondary} !border-ink !bg-ink !text-inverse w-full min-h-12`}>
          {configured ? "Checking the pair token…" : "Trading unavailable"}
        </button>
      ) : !isConnected ? (
        <ConnectWallet className={`${btn.secondary} !border-ink !bg-ink !text-inverse w-full min-h-12`}>
          Connect wallet <ArrowRight size={15} />
        </ConnectWallet>
      ) : !onChain ? (
        <button type="button" onClick={() => void switchChainAsync({ chainId: CHAIN.id })} disabled={switching} className={`${btn.warm} w-full min-h-12`}>
          {switching ? "Switching…" : `Switch to ${CHAIN_LABEL}`}
        </button>
      ) : (
        <button
          type="button"
          onClick={onTrade}
          disabled={busy || amountIn === null || !quote_ || quote_.forKey !== quoteKey || insufficient}
          className={`${confirming ? btn.warm : side === "buy" ? btn.up : `${btn.primary} !bg-down hover:brightness-110`} w-full min-h-12 text-[15px]`}
        >
          {phase.k === "preparing" ? (
            <><Spinner size={14} /> Preparing trade…</>
          ) : phase.k === "approving" ? (
            <>
              <Spinner size={14} /> {phase.step === "erc20" ? "Approve once (1/2)…" : "Allow router (2/2)…"}
            </>
          ) : phase.k === "signing" ? (
            <>
              <Spinner size={14} /> Confirm in your wallet…
            </>
          ) : phase.k === "sent" ? (
            <>
              <Spinner size={14} /> Confirming on {CHAIN_LABEL}…
            </>
          ) : insufficient ? (
            `Not enough ${side === "buy" ? quote.symbol : symbol}`
          ) : confirming && impact !== null ? (
            `Tap again to ${side} at ${fmtImpact(impact)} impact`
          ) : side === "buy" ? (
            `Buy ${symbol}`
          ) : (
            `Sell ${symbol}`
          )}
        </button>
      )}

      {side === "buy" && quote.key === "twig" && (balance === undefined || balance === 0n || insufficient) ? (
        <p className="text-center text-xs text-muted text-pretty">
          Need TWIG? Wrap GITLAWB 1:1 or buy TWIG at{" "}
          <a href={TWIG_WRAP_URL} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-2 hover:text-ink">wrap.twigpine.com ↗</a>
        </p>
      ) : null}
      {phase.k === "error" ? (
        <p className="rounded-xl bg-down-soft border border-down/20 text-down-ink text-sm px-3 py-2" role="alert">
          {phase.message}
        </p>
      ) : null}
      {phase.k === "done" ? (
        <p className="text-xs text-up">
          {phase.side === "buy" ? "Bought" : "Sold"}.{" "}
          <a href={explorerTx(chain, phase.hash)} target="_blank" rel="noreferrer" className="font-code underline underline-offset-2">
            {phase.hash.slice(0, 10)}…
          </a>
        </p>
      ) : null}
      {sold && tokenBalance !== undefined ? (
        <dl className="space-y-1 rounded-xl border border-line bg-paper px-3 py-2.5 text-[11px]">
          <div className="flex justify-between gap-3"><dt className="text-muted">Your {symbol}</dt><dd className="font-mono text-ink tnum">{fmtCompact(Number(tokenBalance) / 1e18)}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-muted">Sell it all now</dt><dd className="text-right font-mono text-body tnum">≈ {fmtQ(sold.out)}{sold.impact !== null ? `, ${fmtImpact(sold.impact)} impact` : ""}</dd></div>
        </dl>
      ) : null}
      </div>
      <div className="border-t border-line px-5 py-3 text-[11px] leading-relaxed text-muted text-pretty">Your wallet trades with the pool directly. openlaunch never holds your funds. Network gas applies.</div>
    </section>
  );
}
