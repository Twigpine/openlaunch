"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useBalance, useConfig, useReadContract, useSwitchChain } from "wagmi";
import { getPublicClient, getWalletClient } from "wagmi/actions";
import { maxUint160, maxUint256, parseEventLogs, parseUnits, zeroAddress, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import TokenAvatar from "./TokenAvatar";
import ImageUpload from "./ImageUpload";
import FeeChip, { feeModeOf } from "./FeeChip";
import LaunchFeeSettings, { type FeeBeneficiary } from "./LaunchFeeSettings";
import GitlawbBadge from "./GitlawbBadge";
import { toast } from "./TxToasts";
import { btn, card, helper, input, label } from "@/components/ui";
import { ERC20_MIN_ABI, ERC20_TRANSFER_EVENT, LAUNCH_FACTORY_ABI, PERMIT2_ABI, UNIVERSAL_ROUTER_ABI, V4_QUOTER_ABI } from "@/lib/launchpad/abi";
import { DEAD, DEFAULT_SUPPLY, FEE_PRESETS, GAS_RESERVE_WEI, MAX_RECIPIENTS, STOCK_SOURCE, TICK_SPACING, launchpad, quoteUsdOf, sharesGasBalance, type Quote } from "@/lib/launchpad/config";
import { bpsToPct, buildRecipients, describeShares, emptyRow, isBurnAddress, type Recipient, type RecipientRow } from "@/lib/launchpad/recipients";
import { capChipLabel, capDisplay, capEntry, capPick, capPresets, capToQuote } from "@/lib/launchpad/market-cap";
import { uppercaseInPlace } from "@/lib/launchpad/symbol-input";
import { resolveCustomMcapInput, resolveFirstBuyInput } from "@/lib/launchpad/decimal-input";
import { fdvForStartTick, fmtCompact, fmtQuoteUnits, fmtUsd, initialBuyPreview, minOut, startTickForFdv, tickToTokensPerQuote, units } from "@/lib/launchpad/math";
import { BUY_PRESETS, defaultFirstBuy, gasReserveInQuote, suggestFirstBuy } from "@/lib/launchpad/first-buy";
import { getFirstBuyDeclined, getFirstBuyDeclinedServer, setFirstBuyDeclined, subscribeFirstBuyDeclined } from "@/lib/launchpad/first-buy-session";
import { encodeV4ExactInSingle, type PoolKey } from "@/lib/launchpad/swap";
import { GITLAWB_SITE } from "@/lib/launchpad/gitlawb";
import { parseXHandle } from "@/lib/launchpad/xHandle";
import { CHAINS, CHAIN_LABELS, CHAIN_KEYS, DEFAULT_CHAIN, BUILDER_DATA_SUFFIX, explorerTx, shortAddr, type ChainKey } from "@/lib/chainPublic";
import { friendlyError } from "@/lib/errors";
import { Spinner } from "@/components/Skeleton";
import { startNav } from "@/components/RouteProgress";
import WalletPicker from "@/components/WalletPicker";

/**
 * Launch flow — honest states, nothing claimed before the chain says so:
 *   idle → saving (metadata → predicted address) → simulating → signing → sent (hash) → [buying] → indexing → done → /t/<token>
 * `buying` is the optional first buy: a second transaction right after the launch is confirmed. It can fail
 * (rejected, sniped past slippage) without the launch failing — the launch is already on-chain by then.
 */
type Phase =
  | { k: "idle" }
  | { k: "saving" }
  | { k: "simulating" }
  | { k: "signing" }
  | { k: "sent"; hash: Hex }
  | { k: "buying"; hash: Hex; step: "quote" | "approve" | "sign" } // hash = the confirmed launch
  | { k: "buying"; hash: Hex; step: "sent"; buyHash: Hex }
  | { k: "indexing"; hash: Hex }
  | { k: "done"; hash: Hex; token: string }
  | { k: "error"; message: string };

// A chain without contracts reads as upcoming to visitors; in development the reason is what matters.
const UNCONFIGURED_CHAIN_COPY = process.env.NODE_ENV === "production" ? "Coming soon." : "Not configured here. Contract settings are missing in this environment.";
const FIRST_BUY_SLIPPAGE_BPS = 300; // Other buyers can trade between the launch and this separate buy.
const PERMIT_EXPIRY_S = 30 * 24 * 3600;
// The native amount kept back from a first buy for gas is per chain (lib/launchpad/config.ts GAS_RESERVE_WEI): the launch
// transaction is sent first and pays its own gas, then the buy (and, for an ERC-20 quote, its approvals).

function randomSalt(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** Shown wherever the form is blocked on a stock choice: one sentence, one place. */
const STOCK_PICK_MESSAGE = "Pick a stock to price the token in, or switch the quote.";

/** Per-chain copy in the form. A chain's quotes and stock registry differ, so its sentences do too; `stock` is null where no registry exists. */
const CHAIN_COPY: Record<ChainKey, { blurb: string; gitlawbOrigin: string; stock: { pays: string; badge: string; empty: string; issuer: string } | null }> = {
  base: {
    blurb: "Priced in ETH, GITLAWB or a Coinbase tokenized stock. Gas ≈ cents.",
    gitlawbOrigin: " on Base",
    stock: {
      pays: "Buyers pay with a Coinbase tokenized stock; fees are paid in that stock.",
      badge: "Coinbase stock",
      empty: "No match. 13 Coinbase tokenized stocks are available on Base: NVDAc, AAPLc, TSLAc, METAc, GOOGLc, AMZNc, MSFTc, MSTRc, COINc, CRCLc, INTCc, SNDKc, SPCXc.",
      issuer: "Coinbase tokenized stocks are securities issued by Coinbase under Regulation S and are not offered to persons in the US, UK, Canada, Australia, Singapore or Switzerland. That is Coinbase's rule for the stock token, not ours. The pool itself is ordinary Uniswap v4.",
    },
  },
  robinhood: {
    blurb: "Priced in USDG (dollars), ETH, GITLAWB or a Robinhood Stock Token. Gas ≈ cents.",
    gitlawbOrigin: ", bridged 1:1 from Base to Robinhood Chain over LayerZero",
    stock: {
      pays: "Buyers pay with a Robinhood Stock Token; fees are paid in that stock.",
      badge: "Robinhood stock",
      empty: "No match. 194 Robinhood Stock Tokens are available, e.g. AAPL, TSLA, NVDA, SPY.",
      issuer: "Robinhood Stock Tokens are tokenised securities issued by Robinhood and are not offered to US persons. That is Robinhood's rule for the stock token, not ours. The pool itself is ordinary Uniswap v4.",
    },
  },
  arc: {
    blurb: "Priced in USDC (dollars). Gas is paid in USDC too: cents per trade, well under a dollar to launch.",
    gitlawbOrigin: "",
    stock: null,
  },
};

type FirstBuyCtx = { pub: PublicClient; wallet: WalletClient; address: Address; V4: ReturnType<typeof launchpad>["v4"]; quote: Quote; feePips: number; CHAIN: (typeof CHAINS)[ChainKey]; setPhase: (p: Phase) => void };

function parseBuyAmount(v: string, decimals: number): bigint | null | undefined {
  try {
    const t = v.trim();
    if (!t) return null;
    const raw = parseUnits(t, decimals);
    return raw > 0n ? raw : null;
  } catch {
    return undefined; // typed something that is not a number
  }
}

/** Buy `amountIn` of the freshly launched token through the Universal Router — same path as the token page's trade panel. */
/** Resolves with what the wallet actually received (from the receipt's Transfer logs); `exact` is false only if no such log was found and the quote is returned instead. */
async function firstBuy(ctx: FirstBuyCtx, tokenAddr: Address, launchHash: Hex, amountIn: bigint): Promise<{ hash: Hex; out: bigint; exact: boolean }> {
  const { pub, wallet, address, V4, quote, feePips, CHAIN, setPhase } = ctx;
  // the factory guarantees the token sorts above the quote, so the quote is always currency0
  const key: PoolKey = { currency0: quote.address, currency1: tokenAddr, fee: feePips, tickSpacing: TICK_SPACING, hooks: zeroAddress };
  setPhase({ k: "buying", hash: launchHash, step: "quote" });
  // public nodes can lag the launch block by one: retry the quote a few times before giving up
  let out: bigint | null = null;
  for (let attempt = 0; out === null; attempt++) {
    try {
      const { result } = await pub.simulateContract({ address: V4.quoter, abi: V4_QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{ poolKey: key, zeroForOne: true, exactAmount: amountIn, hookData: "0x" }] });
      out = result[0];
    } catch (err) {
      if (attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (quote.key !== "eth") {
    const payToken = quote.address;
    const erc20Allowance = await pub.readContract({ address: payToken, abi: ERC20_MIN_ABI, functionName: "allowance", args: [address, V4.permit2] });
    if (erc20Allowance < amountIn) {
      setPhase({ k: "buying", hash: launchHash, step: "approve" });
      const h = await wallet.writeContract({ address: payToken, abi: ERC20_MIN_ABI, functionName: "approve", args: [V4.permit2, maxUint256], dataSuffix: BUILDER_DATA_SUFFIX, chain: CHAIN, account: address });
      await pub.waitForTransactionReceipt({ hash: h });
    }
    const [pAmount, pExp] = await pub.readContract({ address: V4.permit2, abi: PERMIT2_ABI, functionName: "allowance", args: [address, payToken, V4.universalRouter] });
    const now = Math.floor(Date.now() / 1000);
    if (pAmount < amountIn || pExp <= now + 60) {
      setPhase({ k: "buying", hash: launchHash, step: "approve" });
      const h = await wallet.writeContract({ address: V4.permit2, abi: PERMIT2_ABI, functionName: "approve", args: [payToken, V4.universalRouter, maxUint160, now + PERMIT_EXPIRY_S], dataSuffix: BUILDER_DATA_SUFFIX, chain: CHAIN, account: address });
      await pub.waitForTransactionReceipt({ hash: h });
    }
  }
  const { commands, inputs } = encodeV4ExactInSingle({ key, zeroForOne: true, amountIn, minOut: minOut(out, FIRST_BUY_SLIPPAGE_BPS), layout: V4.swapLayout });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const { request } = await pub.simulateContract({
    address: V4.universalRouter,
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: "execute",
    args: [commands, inputs, deadline],
    value: quote.key === "eth" ? amountIn : 0n,
    account: address,
    dataSuffix: BUILDER_DATA_SUFFIX,
  });
  setPhase({ k: "buying", hash: launchHash, step: "sign" });
  const h = await wallet.writeContract(request);
  setPhase({ k: "buying", hash: launchHash, step: "sent", buyHash: h });
  const rc = await pub.waitForTransactionReceipt({ hash: h });
  if (rc.status !== "success") throw new Error("The buy reverted on-chain.");
  // the executed amount can be below the quote (down to the slippage floor): read it off the receipt
  const received = parseEventLogs({ abi: [ERC20_TRANSFER_EVENT], eventName: "Transfer", logs: rc.logs })
    .filter((l) => l.address.toLowerCase() === tokenAddr.toLowerCase() && l.args.to.toLowerCase() === address.toLowerCase())
    .reduce((sum, l) => sum + l.args.value, 0n);
  return received > 0n ? { hash: h, out: received, exact: true } : { hash: h, out, exact: false };
}

export default function LaunchForm({ ethUsd, gitlawbUsd = null, initialChain = DEFAULT_CHAIN }: { ethUsd: number | null; gitlawbUsd?: number | null; initialChain?: ChainKey }) {
  const router = useRouter();
  const [chain, setChain] = useState<ChainKey>(initialChain);
  const cfg = launchpad(chain);
  const CHAIN = CHAINS[chain];
  const CHAIN_LABEL = CHAIN_LABELS[chain];
  const [quoteKey, setQuoteKey] = useState<Quote["key"]>(launchpad(initialChain).quotes[0].key);
  const [stock, setStock] = useState<Quote | null>(null);
  const [stockQ, setStockQ] = useState("");
  const [stockHits, setStockHits] = useState<Quote[]>([]);
  // GITLAWB's USD is live: the page fetched it server-side (same as ethUsd); the static config carries null
  const staticQuote: Quote = quoteKey === "stock" && stock ? stock : (cfg.quotes.find((q) => q.key === quoteKey) ?? cfg.quotes[0]);
  const quote: Quote = staticQuote.key === "gitlawb" ? { ...staticQuote, usd: gitlawbUsd } : staticQuote;
  const quoteUsd = quoteUsdOf(quote, ethUsd);
  const NATIVE_SYMBOL = CHAIN.nativeCurrency.symbol;
  const gasReserve = GAS_RESERVE_WEI[chain];
  // On Arc the USDC quote IS the gas token (one balance, two faces): the reserve then comes out of the quote balance as well.
  const sharedGas = sharesGasBalance(chain, quote);
  const reserveInQuote = quote.key === "eth" || sharedGas ? gasReserveInQuote(gasReserve, quote.decimals) : 0n;
  // stock search (per-chain registry via our server; only registry addresses are ever offered)
  useEffect(() => {
    if (quoteKey !== "stock") return;
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/quotes?chain=${chain}&q=${encodeURIComponent(stockQ)}`, { cache: "no-store" });
        const d = (await res.json()) as { stocks: Quote[] };
        if (alive) setStockHits(d.stocks ?? []);
      } catch {
        if (alive) setStockHits([]);
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [chain, quoteKey, stockQ]);
  const config = useConfig();
  const { address, isConnected, chainId } = useAccount();
  const [pickerOpen, setPickerOpen] = useState(false);
  const { switchChainAsync, isPending: switching } = useSwitchChain();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [image, setImage] = useState("");
  const [website, setWebsite] = useState("");
  const [x, setX] = useState("");
  const [mcapPick, setMcapPick] = useState<number | null>(null);
  const [customMcap, setCustomMcap] = useState("");
  const [feePips, setFeePips] = useState<number>(0);
  const [beneficiary, setBeneficiary] = useState<FeeBeneficiary>("burn");
  // Split editor rows, kept while the creator toggles cards so nothing typed is lost; only read in "custom" mode.
  const [rows, setRows] = useState<RecipientRow[]>([emptyRow()]);
  // First buy: what the creator typed, or the suggestion (lib/launchpad/first-buy.ts) unless they cleared it.
  // A typed amount is bound to the quote it was typed for: switching chain or quote must not carry "25" USDG over as 25 ETH.
  const [typedBuyFor, setTypedBuyFor] = useState<{ amount: string; quoteId: string } | null>(null);
  const quoteId = `${chain}:${quote.address.toLowerCase()}`;
  const typedBuy = typedBuyFor && typedBuyFor.quoteId === quoteId ? typedBuyFor.amount : "";
  // Declined for this tab session (the "No first buy" button) is an external store read with useSyncExternalStore: the
  // server snapshot is false, so server and client markup match during hydration and the client re-renders with the
  // real flag right after (lib/launchpad/first-buy-session.ts). Clearing the field or a chip declines in memory only.
  // Both states are visible on the form with a way back, so a creator who cleared it while exploring never wonders where it went.
  const sessionDeclined = useSyncExternalStore(subscribeFirstBuyDeclined, getFirstBuyDeclined, getFirstBuyDeclinedServer);
  const [declinedNow, setDeclinedNow] = useState(false);
  const buyDeclined = declinedNow || sessionDeclined;
  function declineFirstBuy(forSession = false) { setTypedBuyFor(null); setDeclinedNow(true); if (forSession) setFirstBuyDeclined(true); }
  function suggestAgain() { setTypedBuyFor(null); setDeclinedNow(false); setFirstBuyDeclined(false); }
  function chooseFirstBuy(v: string) { setTypedBuyFor({ amount: v, quoteId }); setDeclinedNow(false); setFirstBuyDeclined(false); }
  // Generated lazily at launch time (a render-time random value would break hydration).
  const saltRef = useRef<Hex | null>(null);
  // The metadataURI is keyed by meta_key, so findSalt can change the salt freely within one attempt. Both refs are
  // kept across attempts so an identical retry is idempotent; when the details changed since the key was registered
  // the server answers 409 and launch() rotates BOTH (a key is locked to the details it was first registered with).
  const metaKeyRef = useRef<Hex | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: "idle" });

  // Starting cap: entered in dollars whenever the quote has a USD price, else in quote units (lib/launchpad/market-cap.ts).
  // The tick is always computed from the quote-denominated cap; every figure shown leads with dollars.
  const entry = capEntry(quoteUsd);
  const presets = capPresets(entry, quote.key);
  const pickedPreset = capPick(mcapPick, presets);
  const mcapEntered = customMcap.trim() ? Number(customMcap) : (pickedPreset ?? 0);
  const mcap = mcapEntered > 0 && Number.isFinite(mcapEntered) ? capToQuote(mcapEntered, entry) : 0;
  const startTick = mcap > 0 && Number.isFinite(mcap) ? startTickForFdv(mcap, quote.decimals) : null;
  const fdvPreview = startTick !== null ? fdvForStartTick(startTick, quote.decimals) : null;
  const tokensPerEth = startTick !== null ? tickToTokensPerQuote(startTick, quote.decimals) : null;
  const cap = (v: number) => capDisplay(v, quoteUsd, quote);

  const onChain = chainId === CHAIN.id;
  // Normalize for the preview and launch payload, never the live IME composition.
  const symbolClean = symbol.trim().toUpperCase();
  // Balances, read as soon as a wallet is connected so the suggestion can be decided: the native balance always (it pays
  // the buy's gas, and the approvals an ERC-20 quote needs first), plus the quote token's balance for an ERC-20 quote.
  const ethBal = useBalance({ address, chainId: CHAIN.id, query: { enabled: Boolean(address), refetchInterval: 15_000 } });
  const quoteBal = useReadContract({ address: quote.address, abi: ERC20_MIN_ABI, functionName: "balanceOf", args: address ? [address] : undefined, chainId: CHAIN.id, query: { enabled: Boolean(address) && quote.key !== "eth", refetchInterval: 15_000 } });
  const nativeBalance: bigint | undefined = ethBal.data?.value;
  const buyBalance: bigint | undefined = quote.key === "eth" ? nativeBalance : (quoteBal.data as bigint | undefined);
  const buyBalanceFailed = quote.key === "eth" ? ethBal.isError : quoteBal.isError;
  // The suggested buy is selected from the start; a connected wallet's balances can only take it away (or a failed read),
  // so it can never block the launch below. A typed amount keeps the strict checks.
  const suggestion = suggestFirstBuy({ quote, connected: Boolean(address) && onChain, balance: buyBalance, nativeBalance, balanceFailed: buyBalanceFailed || ethBal.isError, gasReserve, sharesGasBalance: sharedGas, declined: buyDeclined || Boolean(typedBuy), parse: parseUnits });
  const initialBuy = typedBuy || suggestion.amount || "";
  const buySource: "typed" | "suggested" | "none" = typedBuy ? "typed" : suggestion.amount ? "suggested" : "none";
  const initialBuyRaw = parseBuyAmount(initialBuy, quote.decimals);
  const errors: string[] = [];
  if (name.trim().length === 0 || name.trim().length > 32) errors.push("Name: 1–32 characters.");
  if (!/^[A-Z0-9]{1,10}$/.test(symbolClean)) errors.push("Symbol: use 1–10 English letters (A–Z) or digits (0–9).");
  if (startTick === null) errors.push("Starting market cap must be a positive number.");
  if (quoteKey === "stock" && !stock) errors.push(STOCK_PICK_MESSAGE);
  if (quoteKey === "gitlawb" && quote.usd === null && !customMcap.trim() && startTick === null) errors.push("GITLAWB price unavailable right now: enter a custom starting market cap in GITLAWB, or reload.");
  if (image && !/^https:\/\//.test(image.trim())) errors.push("Image must be an https URL.");
  if (website && !/^https:\/\//.test(website.trim())) errors.push("Website must be an https URL.");
  const xParsed = parseXHandle(x);
  if (!xParsed.ok) errors.push("X: enter a handle or an x.com link.");
  const split = useMemo(() => buildRecipients(rows), [rows]);
  if (feePips > 0 && beneficiary === "custom") errors.push(...split.errors);
  if (initialBuyRaw === undefined) errors.push(`First buy: enter an amount in ${quote.symbol}, or leave it empty.`);

  // the launch is irreversible and the buy comes after it: never let a launch through while the buy's funding is unknown
  if (initialBuyRaw && address && buyBalance === undefined) errors.push(buyBalanceFailed ? `First buy: could not read your ${quote.symbol} balance. Retry, or clear the amount.` : "First buy: checking your balance…");
  if (initialBuyRaw && buyBalance !== undefined && initialBuyRaw + reserveInQuote > buyBalance)
    errors.push(reserveInQuote > 0n ? `First buy: not enough ${quote.symbol} (leave a little for gas).` : `First buy: not enough ${quote.symbol} in this wallet.`);
  // an ERC-20 first buy still pays gas (and its approvals) in the native asset: the token balance alone is not enough
  if (initialBuyRaw && quote.key !== "eth" && !sharedGas && address && nativeBalance === undefined) errors.push(ethBal.isError ? `First buy: could not read your ${NATIVE_SYMBOL} balance for gas. Retry, or clear the amount.` : `First buy: checking your ${NATIVE_SYMBOL} balance for gas…`);
  if (initialBuyRaw && quote.key !== "eth" && !sharedGas && nativeBalance !== undefined && nativeBalance < gasReserve) errors.push(`First buy: not enough ${NATIVE_SYMBOL} for gas (the launch, the approval and the buy each need a little ${NATIVE_SYMBOL}).`);
  const valid = errors.length === 0;
  const buyPreview = initialBuyRaw && startTick !== null ? initialBuyPreview({ startTick, amountInRaw: initialBuyRaw, lpFeePips: feePips, quoteDecimals: quote.decimals }) : null;
  const buyUsd = initialBuyRaw && quoteUsd ? units(initialBuyRaw, quote.decimals) * quoteUsd : null;
  const fmtPct = (p: number) => (p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p.toFixed(2)) + "%";

  const recipients = useMemo<Recipient[]>(() => {
    if (feePips === 0 || beneficiary === "burn") return [];
    if (beneficiary === "me") return address ? [{ payout: address, bps: 10_000 }] : [];
    return split.recipients;
  }, [feePips, beneficiary, address, split]);
  // An unfinished split (or "Me" before a wallet connects) has no recipients yet; that must preview as the routing being set up,
  // never as a burn. Launching stays blocked by the validation errors until the list is complete.
  const feeMode = feePips > 0 && beneficiary !== "burn" && recipients.length === 0 ? (beneficiary === "custom" && rows.length > 1 ? "split" : "creator") : feeModeOf(feePips, recipients);
  const feeRouteSub = feeMode === "free" ? "free pool" : feeMode === "burn" ? "burned" : feeMode === "split" ? `split ${recipients.length || rows.length} ways` : "to beneficiary";
  const setRow = (i: number, patch: Partial<RecipientRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = (payout = "") => setRows((rs) => (rs.length >= MAX_RECIPIENTS ? rs : [...rs, { payout, pct: rs.length === 0 ? "100" : "" }]));
  const removeRow = (i: number) => setRows((rs) => (rs.length <= 1 ? [emptyRow()] : rs.filter((_, j) => j !== i)));
  // Prefer filling an empty address row over appending, so "Add me" on a fresh editor gives one row, not two.
  const quickAdd = (payout: string) => {
    const empty = rows.findIndex((r) => r.payout.trim() === "");
    if (empty >= 0) setRow(empty, { payout, pct: rows[empty].pct || (rows.length === 1 ? "100" : "") });
    else addRow(payout);
  };
  const hasRow = (payout: string) => rows.some((r) => r.payout.trim().toLowerCase() === payout.toLowerCase());

  async function launch() {
    if (!valid || !address || !cfg.factory || startTick === null) return;
    const FACTORY_ADDRESS = cfg.factory;
    let salt = saltRef.current ?? (saltRef.current = randomSalt());
    let metaKey = metaKeyRef.current ?? (metaKeyRef.current = randomSalt());
    const register = async (s: Hex) => {
      const res = await fetch("/api/launch/meta", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chain, launcher: address, salt: s, meta_key: metaKey, name: name.trim(), symbol: symbolClean, description, image_url: image, website, x_handle: x }),
      });
      const j = (await res.json()) as { uri?: string; token?: string; error?: string };
      return { status: res.status, ...j };
    };
    try {
      if (!onChain) await switchChainAsync({ chainId: CHAIN.id });
      setPhase({ k: "saving" });
      let meta = await register(salt);
      if (meta.status === 409) {
        // An earlier attempt registered this key (and salt) with different details, and a key is locked to the
        // details it was first registered with: start a fresh attempt with a new key AND a new salt. The new key
        // then stays fixed for the rest of this attempt, including the salt search below.
        metaKey = metaKeyRef.current = randomSalt();
        salt = saltRef.current = randomSalt();
        meta = await register(salt);
      }
      if (meta.status !== 200 || !meta.uri) throw new Error(meta.error ?? "could not save metadata");

      setPhase({ k: "simulating" });
      const pub = getPublicClient(config, { chainId: CHAIN.id })!;
      if (quote.key !== "eth") {
        // ERC20 quote: the token must sort above the quote address — let the factory pick a salt that does.
        const [found] = await pub.readContract({
          address: FACTORY_ADDRESS,
          abi: LAUNCH_FACTORY_ABI,
          functionName: "findSalt",
          args: [address, salt, name.trim(), symbolClean, DEFAULT_SUPPLY, meta.uri, quote.address, 64n],
        });
        if (found !== salt) {
          salt = found;
          saltRef.current = found;
          // the URI is keyed by meta_key, so it does not change; register the row for the token the new salt produces
          const meta2 = await register(salt);
          if (meta2.status !== 200 || !meta2.uri) throw new Error(meta2.error ?? "could not save metadata");
          if (meta2.uri !== meta.uri) throw new Error("metadata URI changed during the salt search");
          meta.token = meta2.token;
        }
      }
      const params = {
        name: name.trim(),
        symbol: symbolClean,
        metadataURI: meta.uri,
        quote: quote.address as Address,
        supply: DEFAULT_SUPPLY,
        startTick,
        lpFee: feePips,
        salt,
        recipients,
      };
      const { request } = await pub.simulateContract({
        address: FACTORY_ADDRESS,
        abi: LAUNCH_FACTORY_ABI,
        functionName: "launch",
        args: [params],
        account: address,
        dataSuffix: BUILDER_DATA_SUFFIX,
      });

      setPhase({ k: "signing" });
      const wallet = await getWalletClient(config, { chainId: CHAIN.id });
      const hash = await wallet.writeContract(request);
      setPhase({ k: "sent", hash });
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Transaction reverted on-chain.");
      const [ev] = parseEventLogs({ abi: LAUNCH_FACTORY_ABI, eventName: "Launched", logs: receipt.logs });
      const token = (ev?.args.token ?? meta.token ?? "").toLowerCase();

      // Optional first buy. The launch is already on-chain: whatever happens here must not read as a launch failure.
      let buyHash: Hex | null = null;
      let buyProblem: string | null = null;
      let bought: { out: bigint; exact: boolean } | null = null;
      if (initialBuyRaw && ev?.args.token) {
        try {
          const r = await firstBuy({ pub, wallet, address, V4: cfg.v4, quote, feePips, CHAIN, setPhase }, ev.args.token, hash, initialBuyRaw);
          buyHash = r.hash;
          bought = { out: r.out, exact: r.exact };
        } catch (err) {
          buyProblem = friendlyError(err, { slippagePct: FIRST_BUY_SLIPPAGE_BPS / 100 });
        }
      }

      setPhase({ k: "indexing", hash });
      await fetch(`/api/launch/sync?chain=${chain}&tx=${hash}`, { method: "POST" }).catch(() => {});
      if (buyHash) await fetch(`/api/launch/sync?chain=${chain}&tx=${buyHash}`, { method: "POST" }).catch(() => {});
      setPhase({ k: "done", hash, token });
      toast({ kind: "launch", title: `${name.trim()} is live on ${CHAIN_LABEL}`, sub: "Liquidity locked forever. Taking you to your token.", chain, token, symbol: symbolClean, celebrate: true });
      if (bought !== null) toast({ kind: "buy", title: `You bought ${bought.exact ? "" : "about "}${fmtCompact(Number(bought.out) / 1e18)} ${symbolClean}`, sub: "Buy confirmed on " + CHAIN_LABEL, chain, token, symbol: symbolClean });
      if (buyProblem) toast({ kind: "info", title: "Launched, but the first buy did not go through", sub: `${buyProblem} You can buy on the token page.`, chain, token, symbol: symbolClean });
      startNav();
      router.push(`/t/${chain}/${token}`);
    } catch (err) {
      setPhase({ k: "error", message: friendlyError(err) });
    }
  }


  return (
    <div className="grid lg:grid-cols-[minmax(0,1fr)_22rem] gap-6 lg:gap-8 items-start">
      <form
        className="space-y-6 min-w-0"
        onSubmit={(e) => {
          e.preventDefault();
          void launch();
        }}
      >
        {/* chain + quote */}
        <section className={`${card} p-5 space-y-4`}>
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <h2 className="text-sm font-semibold text-ink">Chain</h2>
            <span className="text-xs text-muted">same launch, same rules, on every chain</span>
          </div>
          <div className="grid sm:grid-cols-3 gap-2">
            {CHAIN_KEYS.map((k) => {
              const active = chain === k;
              const ok = launchpad(k).configured;
              return (
                <button
                  type="button"
                  key={k}
                  disabled={!ok}
                  onClick={() => {
                    if (k === chain) return; // the active chain: nothing to switch, nothing to reset
                    setChain(k);
                    setQuoteKey(launchpad(k).quotes[0].key);
                    // a stock belongs to one chain's registry: never carry a Base pick over to Robinhood (or back)
                    setStock(null);
                    setStockQ("");
                    setStockHits([]);
                    setMcapPick(null);
                    setCustomMcap("");
                  }}
                  className={`text-left rounded-xl border p-3.5 transition-colors disabled:opacity-40 ${active ? "border-brand bg-brand-soft" : "border-line-strong bg-card hover:border-ink/40"}`}
                  aria-pressed={active}
                >
                  <div className={`font-semibold text-sm ${active ? "text-brand" : "text-ink"}`}>{CHAIN_LABELS[k]}</div>
                  <div className="text-xs text-body mt-0.5 leading-snug">{!ok ? UNCONFIGURED_CHAIN_COPY : CHAIN_COPY[k].blurb}</div>
                </button>
              );
            })}
          </div>
          {/* every chain offers at least one fixed quote plus tokenized stocks; Base also offers GITLAWB */}
          {cfg.quotes.length > 0 ? (
            <div className="flex items-center gap-2 flex-wrap">
              <span className={label}>Priced in</span>
              <div className="flex items-center rounded-full border border-line bg-card p-0.5" role="group" aria-label="quote asset">
                {[...cfg.quotes.map((q) => ({ key: q.key, label: q.symbol })), ...(STOCK_SOURCE[chain] ? [{ key: "stock" as const, label: "Stock" }] : [])].map((q) => (
                  <button
                    key={q.key}
                    type="button"
                    onClick={() => {
                      setQuoteKey(q.key);
                      setMcapPick(null);
                      setCustomMcap("");
                    }}
                    className={`h-8 px-3 rounded-full text-xs font-mono font-bold ${quoteKey === q.key ? "bg-ink text-inverse" : "text-body hover:text-ink"}`}
                    aria-pressed={quoteKey === q.key}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
              <span className="text-xs text-muted">
                {quote.key === "usdg" || quote.key === "usdc" ? `Buyers pay with ${quote.symbol}; market cap and fees are in dollars.` : quote.key === "gitlawb" ? "Buyers pay with GITLAWB; fees are paid in GITLAWB, or burned." : quote.key === "stock" ? (CHAIN_COPY[chain].stock?.pays ?? "") : "Buyers pay with ETH."}
              </span>
              {cfg.quotes.some((q) => q.key === "gitlawb") && quote.key !== "gitlawb" ? (
                <button type="button" onClick={() => { setQuoteKey("gitlawb"); setMcapPick(null); setCustomMcap(""); }} className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink" title="Pair with GITLAWB and your token carries the GITLAWB badge everywhere on the site">
                  Pair with GITLAWB, get the <GitlawbBadge /> badge
                </button>
              ) : null}
            </div>
          ) : null}
          {quoteKey === "gitlawb" ? (
            <div className="space-y-2">
              <span className="inline-flex items-center gap-2 h-9 pl-1.5 pr-3 rounded-full border border-brand bg-brand-soft text-brand text-sm font-semibold">
                {quote.logo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={quote.logo} alt="" width={22} height={22} className="rounded-md" />
                ) : null}
                {quote.symbol}
                <span className="font-normal text-xs opacity-80">{quote.name}</span>
                {quote.usd ? <span className="font-mono text-xs opacity-80">{fmtUsd(quote.usd)}</span> : <span className="font-mono text-xs opacity-60">price unavailable</span>}
              </span>
              <p className={helper}>
                Your token carries the <GitlawbBadge /> badge on the launch list, trending, the activity feed, its page and its share card. GITLAWB is Gitlawb&apos;s token{CHAIN_COPY[chain].gitlawbOrigin}: an ordinary ERC-20, no transfer restrictions, no issuer switch. Name no beneficiary and every trading fee burns GITLAWB. Price from the Uniswap v4 WETH/GITLAWB pool on Base.{" "}
                <a href={GITLAWB_SITE} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-2 hover:text-ink">gitlawb.com ↗</a>
              </p>
            </div>
          ) : null}
          {quoteKey === "stock" ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                {stock ? (
                  <span className="inline-flex items-center gap-2 h-9 pl-1.5 pr-3 rounded-full border border-brand bg-brand-soft text-brand text-sm font-semibold">
                    {stock.logo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={stock.logo} alt="" width={22} height={22} className={`${stock.logo.startsWith("data:") ? "rounded-md" : "rounded-full"} bg-card`} referrerPolicy="no-referrer" />
                    ) : null}
                    {stock.symbol}
                    <span className="font-normal text-xs opacity-80">{CHAIN_COPY[chain].stock?.badge}</span>
                    <span className="font-normal text-xs opacity-80">{stock.name}</span>
                    {stock.usd ? <span className="font-mono text-xs opacity-80">{fmtUsd(stock.usd)}</span> : null}
                    <button
                      type="button"
                      onClick={() => {
                        setStock(null);
                        setStockQ("");
                      }}
                      aria-label="clear stock quote"
                      className="ml-1 opacity-70 hover:opacity-100"
                    >
                      ×
                    </button>
                  </span>
                ) : (
                  <>
                    <input className={`${input} h-10 max-w-xs font-mono uppercase`} value={stockQ} onChange={(e) => setStockQ(e.target.value)} placeholder="Search ticker, e.g. AAPL" aria-label="search stock tokens" autoComplete="off" />
                    <button
                      type="button"
                      className="text-xs font-semibold text-muted underline underline-offset-2"
                      onClick={() => {
                        setQuoteKey(cfg.quotes[0]?.key ?? "eth");
                        setStock(null);
                        setStockQ("");
                        setMcapPick(null);
                        setCustomMcap("");
                      }}
                    >
                      Switch quote
                    </button>
                  </>
                )}
              </div>
              {!stock ? (
                <ul className="flex flex-wrap gap-1.5">
                  {stockHits.map((h) => (
                    <li key={h.address}>
                      <button
                        type="button"
                        onClick={() => {
                          setStock(h);
                          setMcapPick(null);
                          setCustomMcap("");
                        }}
                        className="inline-flex items-center gap-1.5 h-8 pl-1.5 pr-2.5 rounded-full border border-line bg-card text-xs font-semibold text-ink hover:border-ink/40"
                        title={h.name}
                      >
                        {h.logo ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={h.logo} alt="" width={18} height={18} className={`${h.logo.startsWith("data:") ? "rounded" : "rounded-full"} bg-paper`} referrerPolicy="no-referrer" />
                        ) : null}
                        {h.symbol}
                        {h.usd ? <span className="font-mono font-normal text-muted">{fmtUsd(h.usd)}</span> : null}
                      </button>
                    </li>
                  ))}
                  {stockHits.length === 0 ? <li className="text-xs text-muted">{CHAIN_COPY[chain].stock?.empty}</li> : null}
                </ul>
              ) : null}
              <p className={helper}>{CHAIN_COPY[chain].stock?.issuer}</p>
            </div>
          ) : null}
        </section>

        {/* identity */}
        <section className={`${card} p-5 space-y-4`}>
          <h2 className="text-sm font-semibold text-ink">Token</h2>
          <div className="grid sm:grid-cols-[minmax(0,1fr)_9rem] gap-4">
            <div>
              <label className={label} htmlFor="name">
                Name
              </label>
              <input id="name" className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Clear Sky" maxLength={32} autoComplete="off" />
            </div>
            <div>
              <label className={label} htmlFor="symbol">
                Symbol
              </label>
              <input
                id="symbol"
                className={`${input} font-mono`}
                value={symbol}
                onChange={(e) => {
                  // Rewriting an in-progress IME composition breaks the candidate window: keep it verbatim until it ends.
                  setSymbol((e.nativeEvent as InputEvent).isComposing ? e.target.value : uppercaseInPlace(e.target));
                }}
                onCompositionEnd={(e) => setSymbol(uppercaseInPlace(e.currentTarget))}
                onKeyDown={(e) => {
                  // Some IMEs end composition before the confirming Enter keydown.
                  if (e.key === "Enter" && (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)) e.preventDefault();
                }}
                placeholder="SKY"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                aria-describedby="symbol-help"
                aria-invalid={Boolean(symbol) && !/^[A-Z0-9]{1,10}$/.test(symbolClean)}
              />
              <p id="symbol-help" className={`${helper} mt-2`}>
                1–10 English letters (A–Z) or digits (0–9), published in uppercase. Your token name can use other languages.
              </p>
            </div>
          </div>
          <div>
            <label className={label} htmlFor="desc">
              Description <span className="text-muted font-normal">· optional</span>
            </label>
            <textarea id="desc" className={`${input} h-auto py-3 min-h-20 resize-y`} value={description} onChange={(e) => setDescription(e.target.value.slice(0, 280))} placeholder="What is this? One or two lines." />
            <p className={helper}>{280 - description.length} left</p>
          </div>
          <div>
            <p className={label}>
              Image <span className="text-muted font-normal">· optional, but tokens with a logo get traded</span>
            </p>
            <ImageUpload value={image} onChange={setImage} wallet={address} />
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className={label} htmlFor="web">
                Website <span className="text-muted font-normal">· optional</span>
              </label>
              <input id="web" className={input} value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" inputMode="url" />
            </div>
            <div>
              <label className={label} htmlFor="x">
                X <span className="text-muted font-normal">· optional</span>
              </label>
              <input id="x" className={input} value={x} onChange={(e) => setX(e.target.value)} onBlur={() => { if (xParsed.ok && xParsed.handle) setX(`@${xParsed.handle}`); }} placeholder="@handle or x.com link" autoCapitalize="none" spellCheck={false} />
            </div>
          </div>
        </section>

        {/* price */}
        <section className={`${card} p-5 space-y-4`}>
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <h2 className="text-sm font-semibold text-ink">Starting market cap</h2>
            <span className="text-xs text-muted">1,000,000,000 supply · all of it in the pool</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {presets.map((v) => {
              const active = !customMcap.trim() && pickedPreset === v;
              return (
                <button
                  type="button"
                  key={v}
                  onClick={() => {
                    setMcapPick(v);
                    setCustomMcap("");
                  }}
                  className={`h-11 px-4 rounded-xl border font-mono text-sm font-bold tnum ${active ? "bg-ink text-inverse border-ink" : "bg-card text-ink border-line-strong hover:border-ink/40"}`}
                >
                  {capChipLabel(v, entry, quote)}
                </button>
              );
            })}
            <div className="relative">
              <input
                className={`${input} h-11 w-36 font-mono pr-12`}
                value={customMcap}
                onChange={(e) => {
                  const next = resolveCustomMcapInput(e.target.value);
                  if (next.clearPick) setMcapPick(null);
                  setCustomMcap(next.value);
                }}
                placeholder="custom"
                inputMode="decimal"
                aria-label={`custom starting market cap in ${entry.unit === "usd" ? "USD" : quote.symbol}`}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono text-muted">{entry.unit === "usd" ? "USD" : quote.symbol}</span>
            </div>
          </div>
          {fdvPreview !== null && tokensPerEth !== null ? (
            <p className="text-sm text-body">
              Opens at <span className="font-mono font-bold text-ink tnum">{cap(fdvPreview).main}</span>
              <span className="font-mono text-muted tnum"> · {cap(fdvPreview).detail}</span> fully diluted. The first {quote.key === "gitlawb" ? "1M " : ""}{quote.symbol} buys about{" "}
              <span className="font-mono font-bold text-ink tnum">{fmtCompact(tokensPerEth * (quote.key === "gitlawb" ? 1e6 : 1), 0)}</span> tokens, then the price climbs along the curve.
            </p>
          ) : null}
        </section>

        {/* fees */}
        <LaunchFeeSettings
          feePips={feePips}
          beneficiary={beneficiary}
          address={address}
          split={split}
          onFeeChange={setFeePips}
          onBeneficiaryChange={setBeneficiary}
        >
          <div className="space-y-2">
            {rows.map((r, i) => {
              const burn = isBurnAddress(r.payout);
              return (
                <div key={i} className="flex flex-col sm:flex-row gap-2">
                  <div className="relative min-w-0 flex-1">
                    <input className={`${input} font-mono ${burn ? "pr-20" : ""}`} value={r.payout} onChange={(e) => setRow(i, { payout: e.target.value.trim() })} placeholder="0x…" aria-label={`beneficiary ${i + 1} address`} autoComplete="off" spellCheck={false} />
                    {burn ? <span className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full border border-warm/30 bg-warm-soft px-2 h-6 inline-flex items-center text-[11px] font-medium text-warm-ink pointer-events-none">burned</span> : null}
                  </div>
                  <div className="flex gap-2">
                    <div className="relative w-28 shrink-0">
                      <input className={`${input} font-mono tnum pr-8`} value={r.pct} onChange={(e) => setRow(i, { pct: e.target.value.trim() })} placeholder="0" inputMode="decimal" aria-label={`beneficiary ${i + 1} share, percent`} />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted pointer-events-none" aria-hidden>%</span>
                    </div>
                    <button type="button" className={`${btn.icon} h-12 w-12 shrink-0`} onClick={() => removeRow(i)} aria-label={`remove beneficiary ${i + 1}`} disabled={rows.length === 1 && !r.payout && !r.pct}>
                      ×
                    </button>
                  </div>
                </div>
              );
            })}
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={btn.secondarySm} onClick={() => addRow()} disabled={rows.length >= MAX_RECIPIENTS}>
                + Add address
              </button>
              {address && !hasRow(address) ? (
                <button type="button" className={btn.secondarySm} onClick={() => quickAdd(address)} disabled={rows.length >= MAX_RECIPIENTS && rows.every((x) => x.payout.trim() !== "")}>
                  + Me ({shortAddr(address)})
                </button>
              ) : null}
              {!hasRow(DEAD) ? (
                <button type="button" className={btn.secondarySm} onClick={() => quickAdd(DEAD)} disabled={rows.length >= MAX_RECIPIENTS && rows.every((x) => x.payout.trim() !== "")}>
                  + Burn a share
                </button>
              ) : null}
              <span className={`ml-auto text-xs tnum ${split.remainingBps === 0 ? "text-up" : "text-warm-ink"}`}>
                {split.remainingBps === 0 ? "Shares add up to 100%" : split.remainingBps > 0 ? `${bpsToPct(split.remainingBps)}% left to assign` : `${bpsToPct(-split.remainingBps)}% over`}
              </span>
            </div>
            <p className={helper}>Shares in percent, up to two decimals, must total exactly 100%. A row with 0x…dEaD burns that share.</p>
          </div>
        </LaunchFeeSettings>

        {/* submit */}
        <section className={`${card} p-5 space-y-4`}>
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <h2 className="text-sm font-semibold text-ink">
              First buy <span className="font-normal text-muted">· {buySource === "suggested" ? "suggested" : "optional"}</span>
            </h2>
            <span className="text-xs text-muted">a second transaction, right after the launch confirms</span>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            {BUY_PRESETS[quote.key].map((v) => {
              const active = initialBuy.trim() === v;
              return (
                <button
                  type="button"
                  key={v}
                  onClick={() => (active ? declineFirstBuy() : chooseFirstBuy(v))}
                  className={`h-11 px-4 rounded-xl border font-mono text-sm font-bold tnum ${active ? "bg-ink text-inverse border-ink" : "bg-card text-ink border-line-strong hover:border-ink/40"}`}
                >
                  {fmtQuoteUnits(Number(v), quote.decimals)} {quote.symbol}
                </button>
              );
            })}
            <div className="relative">
              <input
                className={`${input} h-11 w-40 font-mono pr-16`}
                value={initialBuy}
                onChange={(e) => { const next = resolveFirstBuyInput(e.target.value); if (next.kind === "choose") chooseFirstBuy(next.value); else if (next.kind === "decline") declineFirstBuy(); }}
                placeholder="none"
                inputMode="decimal"
                aria-label={`first buy amount in ${quote.symbol}`}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono text-muted">{quote.symbol}</span>
            </div>
            {initialBuyRaw && buyBalance !== undefined ? (
              <span className="text-xs font-mono text-muted tnum">balance {fmtQuoteUnits(units(buyBalance, quote.decimals), quote.decimals)}</span>
            ) : null}
            {initialBuyRaw ? <button type="button" onClick={() => declineFirstBuy(true)} className={btn.secondarySm}>No first buy</button> : null}
          </div>
          {buyPreview ? (
            <p className="text-sm text-body">
              Estimated buy: about <span className="font-mono font-bold text-ink tnum">{fmtCompact(buyPreview.tokensOut, 0)}</span> <span className="break-all">{symbolClean || "tokens"}</span>{" "}
              <span className="font-mono text-muted tnum">({fmtPct(buyPreview.pctOfSupply)} of supply{buyUsd ? ` · ≈ ${fmtUsd(buyUsd)}` : ""})</span>. Estimated market cap after your buy:{" "}
              <span className="font-mono font-bold text-ink tnum">{cap(buyPreview.fdvAfter).main}</span><span className="font-mono text-muted tnum"> · {cap(buyPreview.fdvAfter).detail}</span>. Includes price impact and the pool fee; the exact amount is quoted on-chain right before the buy.
            </p>
          ) : suggestion.reason === "insufficient" ? (
            <p className={helper}>Suggested {fmtQuoteUnits(Number(defaultFirstBuy(quote)), quote.decimals)} {quote.symbol}, but this wallet {sharedGas ? `does not hold enough ${quote.symbol} for the buy plus its gas` : "holds only gas"}. The launch stays free; you can buy on the token page later.</p>
          ) : suggestion.reason === "no-gas" ? (
            <p className={helper}>Suggested {fmtQuoteUnits(Number(defaultFirstBuy(quote)), quote.decimals)} {quote.symbol}, but this wallet has no {NATIVE_SYMBOL} left for the buy&apos;s gas. The launch stays free; you can buy on the token page later.</p>
          ) : suggestion.reason === "unknown-balance" ? (
            <p className={helper}>Could not read your balance, so nothing is suggested. The launch stays free; you can still type an amount.</p>
          ) : suggestion.reason === "declined" && !typedBuy ? (
            <p className={helper}>No first buy. The launch stays free.{defaultFirstBuy(quote) ? <> <button type="button" onClick={suggestAgain} className="font-medium text-brand underline underline-offset-4 hover:text-ink">Suggest {fmtQuoteUnits(Number(defaultFirstBuy(quote)), quote.decimals)} {quote.symbol} again</button></> : null}</p>
          ) : null}
          <p className={helper}>A token with no holders and no price move looks dead on every screener and sits under quiet launches on the home page. Your first buy opens the chart. Clear it and the launch stays free.</p>
          <p className={helper}>Other traders can buy before you. First-buy slippage tolerance: {FIRST_BUY_SLIPPAGE_BPS / 100}%. Network gas and pool fees apply.</p>
        </section>

        <section className={`${card} p-5 space-y-3`}>
          {quoteKey === "stock" && !stock ? (
            <div className="rounded-xl border border-warm/40 bg-warm-soft px-3.5 py-2.5 text-xs text-warm-ink font-semibold" role="status">
              {STOCK_PICK_MESSAGE}
            </div>
          ) : null}
          {errors.length > 0 && (name || symbol) ? (
            <ul className="text-xs text-warm-ink space-y-0.5">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : null}
          <SubmitButton
            chainLabel={CHAIN_LABEL}
            configured={cfg.configured}
            connected={isConnected}
            onChain={onChain}
            connecting={switching}
            valid={valid}
            phase={phase}
            onConnect={() => setPickerOpen(true)}
            onSwitch={() => void switchChainAsync({ chainId: CHAIN.id })}
            label={initialBuyRaw ? "Launch + first buy" : "Launch for free, gas only"}
          />
          {pickerOpen ? <WalletPicker onClose={() => setPickerOpen(false)} /> : null}
          <PhaseNote phase={phase} chain={chain} />
          <p className="text-xs text-muted leading-relaxed">
            One transaction on {CHAIN_LABEL}: deploys the token, creates the Uniswap v4 pool ({quote.symbol} / your token), locks 100% of the supply in it forever, and registers the fee routing. Cost: gas only, usually a few cents.
            Nothing is refundable and nothing can be edited afterwards.
            {initialBuyRaw ? ` Then a second transaction buys ${initialBuy.trim()} ${quote.symbol} of your token${quote.key !== "eth" ? " (with a one-time approval the first time)" : ""}; if you reject it, the launch still stands.` : ""}
          </p>
        </section>
      </form>

      {/* preview */}
      <aside className="lg:sticky lg:top-20 space-y-4 min-w-0 order-first lg:order-none">
        <div className={`${card} p-4`}>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">Preview</p>
          <div className="mt-3 flex items-center gap-3">
            <TokenAvatar chain={chain} token={`0x${symbolClean || "token"}`} symbol={symbolClean || "?"} image={/^https:\/\//.test(image.trim()) ? image.trim() : null} size={48} />
            <div className="min-w-0">
              <div className="font-semibold text-ink truncate">{name.trim() || "Your token"}</div>
              <div className="font-mono text-xs text-muted truncate">{symbolClean || "TICKER"}</div>
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              {quote.key === "gitlawb" ? <GitlawbBadge size="md" /> : null}
              <FeeChip lpFee={feePips} mode={feeMode} />
            </div>
          </div>
          {description.trim() ? <p className="mt-3 text-sm text-body line-clamp-3">{description.trim()}</p> : null}
          <dl className="mt-4 grid grid-cols-2 gap-2">
            <Mini k="Opens at" v={fdvPreview !== null ? cap(fdvPreview).main : "—"} sub={fdvPreview !== null ? cap(fdvPreview).detail : CHAIN_LABELS[chain]} />
            <Mini k="First buy" v={initialBuyRaw ? `${initialBuy.trim()} ${quote.symbol}` : "none"} sub={buyPreview ? `${buySource === "suggested" ? "suggested · " : ""}~${fmtPct(buyPreview.pctOfSupply)} of supply` : "pool opens untouched"} />
            <Mini k="Trading fee" v={FEE_PRESETS.find((f) => f.pips === feePips)?.label ?? "—"} sub={feeRouteSub} />
            <Mini k="Platform fee" v="0" sub="always" accent />
          </dl>
        </div>
        <ul className="text-[13px] text-body space-y-2 px-1">
          {[
            ["Deploys a plain ERC-20", "no mint, no pause, no blacklist, no tax"],
            ["Opens a Uniswap v4 pool", `${quote.symbol} / your token on ${CHAIN_LABELS[chain]}, no hook`],
            ["Locks 100% of supply as liquidity", "the position NFT lives in an ownerless locker, forever"],
            ["Routes trading fees", feePips === 0 ? "nothing to route at 0%" : feeMode === "burn" ? "burned at collect time" : recipients.length === 0 ? "to the beneficiaries you name, claimable any time" : `${describeShares(recipients, shortAddr)}, claimable any time`],
            ...(initialBuyRaw ? [["Buys your first tokens", `${initialBuy.trim()} ${quote.symbol} right after the launch confirms, with a second wallet prompt`]] : []),
          ].map(([t, d]) => (
            <li key={t} className="flex gap-2.5">
              <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-brand shrink-0" aria-hidden />
              <span>
                <span className="font-medium text-ink">{t}</span> <span className="text-muted">{d}</span>
              </span>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

function Mini({ k, v, sub, accent }: { k: string; v: string; sub?: string | null; accent?: boolean }) {
  return (
    <div className="rounded-xl bg-paper border border-line px-3 py-2.5 min-w-0">
      <dt className="text-[11px] text-muted truncate">{k}</dt>
      <dd className={`font-mono font-bold text-sm tnum truncate ${accent ? "text-up" : "text-ink"}`}>{v}</dd>
      {sub ? <dd className="text-[11px] text-muted truncate">{sub}</dd> : null}
    </div>
  );
}

function SubmitButton({
  chainLabel,
  configured,
  connected,
  onChain,
  connecting,
  valid,
  phase,
  onConnect,
  onSwitch,
  label,
}: {
  chainLabel: string;
  configured: boolean;
  connected: boolean;
  onChain: boolean;
  connecting: boolean;
  valid: boolean;
  phase: Phase;
  onConnect: () => void;
  onSwitch: () => void;
  label: string;
}) {
  const cls = `${btn.primary} w-full min-h-12 text-[15px]`;
  if (!configured)
    return (
      <button type="button" disabled className={cls}>
        Launchpad not configured
      </button>
    );
  if (!connected)
    return (
      <button type="button" onClick={onConnect} disabled={connecting} className={cls}>
        {connecting ? "Connecting…" : "Connect wallet to launch"}
      </button>
    );
  if (!onChain)
    return (
      <button type="button" onClick={onSwitch} disabled={connecting} className={`${btn.warm} w-full min-h-12 text-[15px]`}>
        {connecting ? "Switching…" : `Switch to ${chainLabel}`}
      </button>
    );
  const busyLabel: Partial<Record<Phase["k"], string>> = {
    saving: "Saving details…",
    simulating: "Checking the launch…",
    signing: "Confirm in your wallet…",
    sent: `Confirming on ${chainLabel}…`,
    buying: "Launched! Buying your first tokens…",
    indexing: "Almost there…",
    done: "Launched!",
  };
  const busy = busyLabel[phase.k];
  return (
    <button type="submit" disabled={!valid || Boolean(busy)} className={cls}>
      {busy ? (
        <>
          <Spinner size={14} /> {busy}
        </>
      ) : (
        label
      )}
    </button>
  );
}

function PhaseNote({ phase, chain }: { phase: Phase; chain: ChainKey }) {
  if (phase.k === "error")
    return (
      <p className="rounded-xl bg-down-soft border border-down/20 text-down-ink text-sm px-3 py-2" role="alert">
        {phase.message}
      </p>
    );
  if (phase.k === "sent" || phase.k === "buying" || phase.k === "indexing" || phase.k === "done")
    return (
      <p className="text-xs text-muted">
        {phase.k === "buying" && phase.step === "sent" ? "Launched. Buy " : phase.k === "buying" ? "Launch " : "Transaction "}
        <a href={explorerTx(chain, phase.k === "buying" && phase.step === "sent" ? phase.buyHash : phase.hash)} target="_blank" rel="noreferrer" className="font-mono underline underline-offset-2 hover:text-ink">
          {(phase.k === "buying" && phase.step === "sent" ? phase.buyHash : phase.hash).slice(0, 10)}…
        </a>
        {phase.k === "done"
          ? " confirmed. Taking you to your token."
          : phase.k === "buying"
            ? phase.step === "quote"
              ? " confirmed. Pricing your first buy…"
              : phase.step === "approve"
                ? " confirmed. Approve the quote token in your wallet (one time)…"
                : phase.step === "sign"
                  ? " confirmed. Confirm the buy in your wallet…"
                  : " sent, waiting for confirmation…"
            : " sent."}
      </p>
    );
  return null;
}
