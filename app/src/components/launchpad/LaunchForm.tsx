"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChartCandlestick, Check, CircleDollarSign, Globe, Rocket } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "use-intl";
import type { Messages } from "@/i18n/messages";
import { useBalance, useConfig, useReadContract, useSwitchChain } from "wagmi";
import { useHydratedAccount } from "@/lib/useHydratedAccount";
import { getPublicClient, getWalletClient } from "wagmi/actions";
import { maxUint160, maxUint256, parseEventLogs, parseUnits, zeroAddress, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import LaunchPreview from "./LaunchPreview";
import { previewLaunch } from "@/lib/launchpad/launch-preview";
import ImageUpload from "./ImageUpload";
import FeeChip, { feeModeOf } from "./FeeChip";
import LaunchFeeSettings, { type FeeBeneficiary } from "./LaunchFeeSettings";
import { QuoteBrandBadge } from "./MuseworldBadge";
import { GitlawbMark } from "./GitlawbBadge";
import { TwigMark } from "./TwigBadge";
import { ChainLogo } from "./ChainLogo";
import { XMark } from "./BrandMarks";
import { ToggleGroup, ToggleGroupItem } from "@/components/vendor/toggle-group";
import { toast } from "./TxToasts";
import { btn, card, helper, input, label } from "@/components/ui";
import { ERC20_MIN_ABI, ERC20_TRANSFER_EVENT, LAUNCH_FACTORY_ABI, PERMIT2_ABI, UNIVERSAL_ROUTER_ABI, V4_QUOTER_ABI } from "@/lib/launchpad/abi";
import { DEAD, DEFAULT_SUPPLY, FEE_PRESETS, GAS_RESERVE_WEI, MAX_RECIPIENTS, STOCK_SOURCE, TICK_SPACING, launchpad, quoteUsdOf, sharesGasBalance, type Quote } from "@/lib/launchpad/config";
import { bpsToPct, buildRecipients, describeShares, emptyRow, isBurnAddress, type Recipient, type RecipientRow } from "@/lib/launchpad/recipients";
import { capChipLabel, capDisplay, capEntry, capPick, capPresets, capToQuote } from "@/lib/launchpad/market-cap";
import { uppercaseInPlace } from "@/lib/launchpad/symbol-input";
import { resolveCustomMcapInput, resolveFirstBuyInput } from "@/lib/launchpad/decimal-input";
import { fdvForStartTick, fmtCompact, fmtQuoteUnits, fmtUnitsExact, fmtUsd, initialBuyPreview, minOut, startTickForFdv, tickToTokensPerQuote, units } from "@/lib/launchpad/math";
import { BUY_PRESETS, defaultFirstBuy, gasReserveInQuote, suggestFirstBuy } from "@/lib/launchpad/first-buy";
import { getFirstBuyDeclined, getFirstBuyDeclinedServer, setFirstBuyDeclined, subscribeFirstBuyDeclined } from "@/lib/launchpad/first-buy-session";
import { encodeV4ExactInSingle, type PoolKey } from "@/lib/launchpad/swap";
import { GITLAWB_SITE } from "@/lib/launchpad/gitlawb";
import { TWIG_WRAP_URL, gitlawbLinkedUsd } from "@/lib/launchpad/twig";
import { parseXHandle } from "@/lib/launchpad/xHandle";
import { CHAINS, CHAIN_LABELS, CHAIN_KEYS, DEFAULT_CHAIN, BUILDER_DATA_SUFFIX, explorerTx, shortAddr, type ChainKey } from "@/lib/chainPublic";
import { friendlyError } from "@/lib/errors";
import { Spinner } from "@/components/Skeleton";
import { startNav } from "@/components/RouteProgress";
import WalletPicker from "@/components/WalletPicker";
import { randomHex } from "@/lib/nonce";

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

// A chain without contracts reads as upcoming to visitors; in development the reason is what matters (launch.form.chain.*).
const UNCONFIGURED_CHAIN_COPY = process.env.NODE_ENV === "production" ? "comingSoon" : "notConfigured";
const FIRST_BUY_SLIPPAGE_BPS = 300; // Other buyers can trade between the launch and this separate buy.
const PERMIT_EXPIRY_S = 30 * 24 * 3600;
// The native amount kept back from a first buy for gas is per chain (lib/launchpad/config.ts GAS_RESERVE_WEI): the launch
// transaction is sent first and pays its own gas, then the buy (and, for an ERC-20 quote, its approvals).

function randomSalt(): Hex {
  return `0x${randomHex(32)}`;
}

/**
 * Per-chain copy in the form. A chain's quotes and stock registry differ, so its sentences do too: each chain has its
 * blurb (launch.form.chain.blurb.<chain>), `stock` names its registry's copy (launch.form.stock.<registry>) and is null
 * where no registry exists, and `bridgedGitlawb` says where the chain's GITLAWB comes from.
 */
const CHAIN_COPY: Record<ChainKey, { stock: "coinbase" | "robinhood" | null; bridgedGitlawb: boolean }> = {
  base: { stock: "coinbase", bridgedGitlawb: false }, // the Base form offers TWIG, not GITLAWB, so the GITLAWB copy is never shown there
  robinhood: { stock: "robinhood", bridgedGitlawb: true },
  arc: { stock: null, bridgedGitlawb: false },
};

type Reason = keyof Messages["launch"]["form"]["reasons"];
/**
 * Why a launch or its first buy failed, as messages: the English reasons the metadata route and this form's own checks
 * give. friendlyError (lib/errors.ts) already words its reasons in the reader's language (the errors area), and any
 * other text, such as a wallet's or a node's own error, reads as it came.
 */
const REASONS = new Map<string, Reason>([
  ["could not save metadata", "metadata"],
  ["metadata URI changed during the salt search", "metadataChanged"],
  ["Transaction reverted on-chain.", "txReverted"],
  ["The buy reverted on-chain.", "buyReverted"],
  ["slow down", "slowDown"],
  ["launchpad unconfigured", "unconfigured"],
]);

/** A failure reason (see REASONS) in the reader's language. */
function useReason() {
  const t = useTranslations("launch.form.reasons");
  return useCallback((reason: string) => {
    const key = REASONS.get(reason);
    return key ? t(key) : reason;
  }, [t]);
}

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
  const t = useTranslations("launch.form");
  const explain = useReason();
  const [chain, setChain] = useState<ChainKey>(initialChain);
  const cfg = launchpad(chain);
  const CHAIN = CHAINS[chain];
  const CHAIN_LABEL = CHAIN_LABELS[chain];
  const [quoteKey, setQuoteKey] = useState<Quote["key"]>(launchpad(initialChain).quotes[0].key);
  const [stock, setStock] = useState<Quote | null>(null);
  const [stockQ, setStockQ] = useState("");
  const [stockHits, setStockHits] = useState<Quote[]>([]);
  const [stockTotal, setStockTotal] = useState(0); // how many stocks the chain's registry holds; the list below shows one page of them
  const [stockMatched, setStockMatched] = useState(0); // how many match the search in all
  const [stockAnswered, setStockAnswered] = useState<string | null>(null); // the search text the page shown answers
  // GITLAWB's USD is live: the page fetched it server-side (same as ethUsd); the static config carries null. TWIG unwraps 1:1 to GITLAWB, so it takes the same price (gitlawbLinkedUsd).
  const staticQuote: Quote = quoteKey === "stock" && stock ? stock : (cfg.quotes.find((q) => q.key === quoteKey) ?? cfg.quotes[0]);
  const linkedUsd = gitlawbLinkedUsd(staticQuote.key, gitlawbUsd);
  const quote: Quote = linkedUsd === undefined ? staticQuote : { ...staticQuote, usd: linkedUsd };
  // the branded quote this chain's form offers, if any: TWIG on Base, GITLAWB on Robinhood Chain
  const brandQuote = cfg.quotes.find((q) => q.key === "twig") ?? cfg.quotes.find((q) => q.key === "gitlawb") ?? null;
  // TWIG and GITLAWB: badged, priced at GITLAWB's live price, millions of units per dollar
  const isBrandQuote = quote.key === "twig" || quote.key === "gitlawb";
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
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/quotes?chain=${chain}&q=${encodeURIComponent(stockQ)}`, { cache: "no-store" });
        const d = (await res.json()) as { stocks: Quote[]; stocksTotal?: number; stocksMatched?: number };
        if (alive) {
          setStockHits(d.stocks ?? []);
          setStockTotal(d.stocksTotal ?? 0);
          setStockMatched(d.stocksMatched ?? 0);
          setStockAnswered(stockQ);
        }
      } catch {
        if (alive) setStockHits([]);
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [chain, quoteKey, stockQ]);
  // How many stocks the page leaves out. Only once the page answers the search as typed: a reply still on its way says nothing about the new text.
  const stockMore = !stock && stockAnswered === stockQ && stockHits.length > 0 ? Math.max(0, (stockQ.trim() ? stockMatched : stockTotal) - stockHits.length) : 0;
  // this chain's stock registry copy (CHAIN_COPY), null where the chain has none
  const registry = CHAIN_COPY[chain].stock;
  const stockCopy = registry ? { pays: t(`stock.${registry}.pays`), badge: t(`stock.${registry}.badge`), empty: t(`stock.${registry}.empty`), issuer: t(`stock.${registry}.issuer`) } : null;
  const config = useConfig();
  const { address, isConnected, chainId } = useHydratedAccount();
  const [pickerOpen, setPickerOpen] = useState(false);
  const { switchChainAsync, isPending: switching } = useSwitchChain();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [image, setImage] = useState("");
  const [banner, setBanner] = useState("");
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
  // "1,000,000 TWIG", not "1000000 TWIG": every digit of what the buy will send, grouped (never rounded, it is what the creator confirms)
  const initialBuyLabel = initialBuyRaw ? `${fmtUnitsExact(initialBuyRaw, quote.decimals)} ${quote.symbol}` : "";
  const errors: string[] = [];
  /** Shown wherever the form is blocked on a stock choice: one sentence, one place. */
  const stockPick = t("stock.pick");
  // the token step's checks, named once: the validation list and the step rail both read them
  const nameOk = name.trim().length > 0 && name.trim().length <= 32;
  const symbolOk = /^[A-Z0-9]{1,10}$/.test(symbolClean);
  const httpsOrEmpty = (v: string) => !v || /^https:\/\//.test(v.trim());
  if (!nameOk) errors.push(t("token.nameInvalid"));
  if (!symbolOk) errors.push(t("token.symbolInvalid"));
  if (startTick === null) errors.push(t("price.capInvalid"));
  if (quoteKey === "stock" && !stock) errors.push(stockPick);
  if (isBrandQuote && quote.usd === null && !customMcap.trim() && startTick === null) errors.push(t("price.brandUnpriced", { symbol: quote.symbol }));
  if (!httpsOrEmpty(image)) errors.push(t("token.imageInvalid"));
  if (!httpsOrEmpty(banner)) errors.push(t("token.bannerInvalid"));
  if (!httpsOrEmpty(website)) errors.push(t("token.websiteInvalid"));
  const xParsed = parseXHandle(x);
  if (!xParsed.ok) errors.push(t("token.xInvalid"));
  // the market row this launch will have, for the preview: the same card it gets on the board
  const previewRow = previewLaunch({ chain, name, symbol: symbolClean, description, image, banner, website, xHandle: xParsed.ok ? xParsed.handle || null : null, fdvQuote: fdvPreview, quote: { key: quote.key, symbol: quote.symbol, decimals: quote.decimals, usd: quoteUsd }, lpFee: feePips, launcher: address ?? null, unnamed: t("unnamed") });
  const split = useMemo(() => buildRecipients(rows), [rows]);
  if (feePips > 0 && beneficiary === "custom") errors.push(...split.errors);
  const buyChecksFrom = errors.length; // the first-buy checks run last, so the step rail can tell whether any of them failed
  if (initialBuyRaw === undefined) errors.push(t("buy.errors.amount", { symbol: quote.symbol }));

  // the launch is irreversible and the buy comes after it: never let a launch through while the buy's funding is unknown
  if (initialBuyRaw && address && buyBalance === undefined) errors.push(buyBalanceFailed ? t("buy.errors.balanceFailed", { symbol: quote.symbol }) : t("buy.errors.balanceChecking"));
  if (initialBuyRaw && buyBalance !== undefined && initialBuyRaw + reserveInQuote > buyBalance)
    errors.push(reserveInQuote > 0n ? t("buy.errors.shortWithGas", { symbol: quote.symbol }) : t("buy.errors.short", { symbol: quote.symbol }));
  // an ERC-20 first buy still pays gas (and its approvals) in the native asset: the token balance alone is not enough
  if (initialBuyRaw && quote.key !== "eth" && !sharedGas && address && nativeBalance === undefined) errors.push(ethBal.isError ? t("buy.errors.gasFailed", { native: NATIVE_SYMBOL }) : t("buy.errors.gasChecking", { native: NATIVE_SYMBOL }));
  if (initialBuyRaw && quote.key !== "eth" && !sharedGas && nativeBalance !== undefined && nativeBalance < gasReserve) errors.push(t("buy.errors.gasShort", { native: NATIVE_SYMBOL }));
  const valid = errors.length === 0;
  // the rail beside the steps: a check once a step is complete (the first buy is optional, so it is complete unless its amount fails a check)
  const done = {
    chain: cfg.configured && !(quoteKey === "stock" && !stock),
    token: nameOk && symbolOk && httpsOrEmpty(image) && httpsOrEmpty(banner) && httpsOrEmpty(website) && xParsed.ok,
    price: startTick !== null,
    fees: !(feePips > 0 && beneficiary === "custom" && split.errors.length > 0),
    buy: errors.length === buyChecksFrom,
  };
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
  const feeRouteSub = feeMode === "free" ? t("feeRoute.free") : feeMode === "burn" ? t("feeRoute.burned") : feeMode === "split" ? t("feeRoute.split", { count: recipients.length || rows.length }) : t("feeRoute.beneficiary");
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
        body: JSON.stringify({ chain, launcher: address, salt: s, meta_key: metaKey, name: name.trim(), symbol: symbolClean, description, image_url: image, banner_url: banner, website, x_handle: x }),
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
      toast({ kind: "launch", title: t("toast.live", { name: name.trim(), chain: CHAIN_LABEL }), sub: t("toast.liveSub"), chain, token, symbol: symbolClean, celebrate: true });
      if (bought !== null) toast({ kind: "buy", title: t(bought.exact ? "toast.bought" : "toast.boughtAbout", { amount: fmtCompact(Number(bought.out) / 1e18), symbol: symbolClean }), sub: t("toast.buyConfirmed", { chain: CHAIN_LABEL }), chain, token, symbol: symbolClean });
      if (buyProblem) toast({ kind: "info", title: t("toast.buyFailed"), sub: t("toast.buyFailedSub", { reason: explain(buyProblem) }), chain, token, symbol: symbolClean });
      startNav();
      router.push(`/t/${chain}/${token}`);
    } catch (err) {
      setPhase({ k: "error", message: friendlyError(err) });
    }
  }


  // the launch action: what is still missing, the button and the transaction's progress. The sticky console shows it on
  // wide screens and the last step shows it on phones; CSS draws one copy at a time.
  const action = (
    <div className="space-y-3">
      {quoteKey === "stock" && !stock ? (
        <div className="rounded-xl border border-warm/40 bg-warm-soft px-3.5 py-2.5 text-xs text-warm-ink font-semibold" role="status">
          {stockPick}
        </div>
      ) : null}
      {errors.length > 0 && (name || symbol) ? (
        <ul className="space-y-1 text-xs text-warm-ink">
          {errors.map((e) => (
            <li key={e} className="flex gap-2">
              <span aria-hidden className="mt-[5px] size-1 shrink-0 rounded-full bg-warm" />
              {e}
            </li>
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
        label={initialBuyRaw ? t("submit.launchBuy") : t("submit.launchFree")}
      />
      <PhaseNote phase={phase} chain={chain} />
    </div>
  );
  // what a preset opens at once the price snaps to the pool's tick spacing, in the quote: "$25K" opens at 9.433 ETH
  const presetOpens = (v: number) => cap(fdvForStartTick(startTickForFdv(capToQuote(v, entry), quote.decimals), quote.decimals)).detail;

  return (
    <div className="grid lg:grid-cols-[minmax(0,1fr)_23rem] gap-6 lg:gap-10 items-start">
      <form
        id="launch-form"
        className="min-w-0"
        onSubmit={(e) => {
          e.preventDefault();
          void launch();
        }}
      >
        <ol className="space-y-5">
          {/* 1 · chain + quote */}
          <Step n={1} done={done.chain}>
            <section className={`${card} p-5 space-y-4`}>
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <h2 className="text-sm font-semibold text-ink">{t("chain.heading")}</h2>
                <span className="text-xs text-muted">{t("chain.note")}</span>
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
                        setStockTotal(0);
                        setStockMatched(0);
                        setStockAnswered(null);
                        setMcapPick(null);
                        setCustomMcap("");
                      }}
                      className={`text-left rounded-xl border p-3.5 transition-colors disabled:opacity-40 motion-reduce:transition-none ${active ? "border-brand bg-brand-soft" : "border-line-strong bg-card hover:border-ink/40"}`}
                      aria-pressed={active}
                    >
                      <span className="flex items-center gap-2.5">
                        <ChainLogo chain={k} size={22} />
                        <span className={`font-semibold text-sm ${active ? "text-brand" : "text-ink"}`}>{CHAIN_LABELS[k]}</span>
                        {active ? <Check size={15} strokeWidth={2.6} aria-hidden="true" className="ml-auto shrink-0 text-brand" /> : null}
                      </span>
                      <span className="mt-2 block text-xs text-body leading-snug">{!ok ? t(`chain.${UNCONFIGURED_CHAIN_COPY}`) : t(`chain.blurb.${k}`)}</span>
                    </button>
                  );
                })}
              </div>
              {/* every chain offers at least one fixed quote plus tokenized stocks; Base also offers TWIG, Robinhood Chain GITLAWB */}
              {cfg.quotes.length > 0 ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span className="text-sm font-medium text-ink">{t("quote.pricedIn")}</span>
                    <ToggleGroup aria-label={t("quote.label")} value={[quoteKey]} onValueChange={(values) => { const next = values[0] as Quote["key"] | undefined; if (!next) return; setQuoteKey(next); setMcapPick(null); setCustomMcap(""); }}>
                      {[...cfg.quotes.map((q) => ({ key: q.key, label: q.symbol })), ...(STOCK_SOURCE[chain] ? [{ key: "stock" as const, label: t("quote.stock") }] : [])].map((q) => (
                        <ToggleGroupItem key={q.key} value={q.key} className="px-3 text-xs font-semibold">
                          <QuoteMark k={q.key} />
                          {q.label}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                  </div>
                  <p className="text-xs text-muted">
                    {/* the picked quote key, not the resolved quote: with Stock chosen and no stock yet, the quote still falls back to the first one */}
                    {quoteKey === "stock" ? (stockCopy?.pays ?? "") : quote.key === "usdg" || quote.key === "usdc" ? t("quote.paysDollars", { symbol: quote.symbol }) : isBrandQuote ? t("quote.paysBrand", { symbol: quote.symbol }) : t("quote.paysEth")}
                  </p>
                  {brandQuote && quote.key !== brandQuote.key ? (
                    <button type="button" onClick={() => { setQuoteKey(brandQuote.key); setMcapPick(null); setCustomMcap(""); }} className="inline-flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-ink motion-reduce:transition-none" title={t("quote.pairTitle", { symbol: brandQuote.symbol })}>
                      {t.rich("quote.pair", { symbol: brandQuote.symbol, badge: () => <QuoteBrandBadge quoteKey={brandQuote.key} /> })}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {isBrandQuote ? (
                <div className="space-y-2">
                  <span className="inline-flex items-center gap-2 h-9 pl-1.5 pr-3 rounded-full border border-brand bg-brand-soft text-brand text-sm font-semibold">
                    {quote.logo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={quote.logo} alt="" width={22} height={22} className="rounded-md" />
                    ) : null}
                    {quote.symbol}
                    <span className="font-normal text-xs opacity-80">{quote.name}</span>
                    {quote.usd ? <span className="font-mono text-xs opacity-80">{fmtUsd(quote.usd)}</span> : <span className="font-mono text-xs opacity-60">{t("quote.priceUnavailable")}</span>}
                  </span>
                  <p className={helper}>
                    {t.rich(quote.key === "twig" ? "quote.brandTwig" : "quote.brandGitlawb", {
                      bridged: CHAIN_COPY[chain].bridgedGitlawb ? "yes" : "no",
                      site: quote.key === "twig" ? "wrap.twigpine.com" : "twigpine.com",
                      badge: () => <QuoteBrandBadge quoteKey={quote.key} />,
                      link: (chunks) => <a href={quote.key === "twig" ? TWIG_WRAP_URL : GITLAWB_SITE} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-2 hover:text-ink">{chunks}</a>,
                    })}
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
                        <span className="font-normal text-xs opacity-80">{stockCopy?.badge}</span>
                        <span className="font-normal text-xs opacity-80">{stock.name}</span>
                        {stock.usd ? <span className="font-mono text-xs opacity-80">{fmtUsd(stock.usd)}</span> : null}
                        <button
                          type="button"
                          onClick={() => {
                            setStock(null);
                            setStockQ("");
                          }}
                          aria-label={t("stock.clear")}
                          className="ml-1 opacity-70 hover:opacity-100"
                        >
                          ×
                        </button>
                      </span>
                    ) : (
                      <>
                        <input className={`${input} h-10 max-w-xs font-mono uppercase`} value={stockQ} onChange={(e) => setStockQ(e.target.value)} placeholder={t("stock.searchPlaceholder")} aria-label={t("stock.searchLabel")} autoComplete="off" />
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
                          {t("stock.switchQuote")}
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
                            title={h.issued === false ? t("stock.noneIssuedTitle", { name: h.name ?? h.symbol }) : h.name}
                          >
                            {h.logo ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={h.logo} alt="" width={18} height={18} className={`${h.logo.startsWith("data:") ? "rounded" : "rounded-full"} bg-paper`} referrerPolicy="no-referrer" />
                            ) : null}
                            {h.symbol}
                            {h.usd ? <span className="font-mono font-normal text-muted">{fmtUsd(h.usd)}</span> : null}
                            {h.issued === false ? <span className="font-normal text-muted">{t("stock.notIssued")}</span> : null}
                          </button>
                        </li>
                      ))}
                      {stockHits.length === 0 ? <li className="text-xs text-muted">{stockCopy?.empty}</li> : null}
                    </ul>
                  ) : null}
                  {/* a listed stock with no supply: the launch works, but until the issuer puts some in circulation nobody holds any to buy with */}
                  {stock?.issued === false ? (
                    <p className={helper}>
                      {t("stock.noneIssued", { symbol: stock.symbol })}
                    </p>
                  ) : null}
                  {/* the list is one page: say how many more there are, or the rest stays invisible (a broad search like "S" has more matches than fit) */}
                  {stockMore > 0 ? (
                    <p className={helper}>
                      {stockQ.trim() ? t("stock.showingMatches", { shown: stockHits.length, total: stockHits.length + stockMore }) : t("stock.showing", { shown: stockHits.length, total: stockHits.length + stockMore })}
                    </p>
                  ) : null}
                  <p className={helper}>{stockCopy?.issuer}</p>
                </div>
              ) : null}
            </section>
          </Step>

          {/* 2 · identity */}
          <Step n={2} done={done.token}>
            <section className={`${card} p-5 space-y-5`}>
              <h2 className="text-sm font-semibold text-ink">{t("token.heading")}</h2>
              <div>
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem]">
                  <div>
                    <label className={label} htmlFor="name">
                      {t("token.name")}
                    </label>
                    <div className="relative">
                      <input id="name" className={`${input} pr-16`} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("token.namePlaceholder")} maxLength={32} autoComplete="off" />
                      <span aria-hidden="true" className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 font-mono text-[11px] text-faint tnum">{name.length}/32</span>
                    </div>
                  </div>
                  <div>
                    <label className={label} htmlFor="symbol">
                      {t("token.symbol")}
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
                  </div>
                </div>
                {/* under both fields, so the symbol's rule reads in one line instead of a narrow column */}
                <p id="symbol-help" className={helper}>
                  {t("token.symbolHelp")}
                </p>
              </div>
              <div>
                <label className={label} htmlFor="desc">
                  {t("token.description")} <span className="text-muted font-normal">{t("optional")}</span>
                </label>
                <textarea id="desc" className={`${input} h-auto py-3 min-h-24 resize-y`} value={description} onChange={(e) => setDescription(e.target.value.slice(0, 280))} placeholder={t("token.descriptionPlaceholder")} />
                <p className={`${helper} text-right tnum`}>{t("token.left", { count: 280 - description.length })}</p>
              </div>
              <div>
                <p className={label}>
                  {t("token.artwork")} <span className="text-muted font-normal">{t("token.artworkHint")}</span>
                </p>
                {/* the logo and the banner side by side, the way the card wears them */}
                <div className="grid gap-3 sm:grid-cols-[11rem_minmax(0,1fr)]">
                  <ImageUpload value={image} onChange={setImage} wallet={address} stacked />
                  <ImageUpload kind="banner" value={banner} onChange={setBanner} wallet={address} stacked />
                </div>
                <p className={helper}>{t("token.artworkHelp")}</p>
              </div>
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className={label} htmlFor="web">
                    {t("token.website")} <span className="text-muted font-normal">{t("optional")}</span>
                  </label>
                  <div className="relative">
                    <Globe size={16} aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
                    <input id="web" className={`${input} pl-11`} value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" inputMode="url" />
                  </div>
                </div>
                <div>
                  <label className={label} htmlFor="x">
                    X <span className="text-muted font-normal">{t("optional")}</span>
                  </label>
                  <div className="relative">
                    <span aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted"><XMark className="size-3.5" /></span>
                    <input id="x" className={`${input} pl-11`} value={x} onChange={(e) => setX(e.target.value)} onBlur={() => { if (xParsed.ok && xParsed.handle) setX(`@${xParsed.handle}`); }} placeholder={t("token.xPlaceholder")} autoCapitalize="none" spellCheck={false} />
                  </div>
                </div>
              </div>
            </section>
          </Step>

          {/* 3 · price */}
          <Step n={3} done={done.price}>
            <section className={`${card} p-5 space-y-4`}>
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <h2 className="text-sm font-semibold text-ink">{t("price.heading")}</h2>
                <span className="text-xs text-muted">{t("price.supply")}</span>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
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
                      aria-pressed={active}
                      className={`${choice} ${active ? choiceOn : choiceOff}`}
                    >
                      <span className="block truncate font-mono text-[15px] font-bold tnum">{capChipLabel(v, entry, quote)}</span>
                      {entry.unit === "usd" ? <span className={`mt-0.5 block truncate font-mono text-[11px] tnum ${active ? "text-brand" : "text-muted"}`}>{presetOpens(v)}</span> : null}
                    </button>
                  );
                })}
                <div className={`relative ${presets.length ? "col-span-2 sm:col-span-1" : "col-span-2 sm:col-span-5"}`}>
                  <input
                    className={`${input} h-full min-h-14 font-mono pr-12 ${customMcap.trim() ? "border-brand" : ""}`}
                    value={customMcap}
                    onChange={(e) => {
                      const next = resolveCustomMcapInput(e.target.value);
                      if (next.clearPick) setMcapPick(null);
                      setCustomMcap(next.value);
                    }}
                    placeholder={t("price.custom")}
                    inputMode="decimal"
                    aria-label={t("price.customLabel", { unit: entry.unit === "usd" ? "USD" : quote.symbol })}
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono text-muted">{entry.unit === "usd" ? "USD" : quote.symbol}</span>
                </div>
              </div>
              {/* a stock without a price feed (most Coinbase stocks) has no dollar presets: say why the box wants stock units */}
              {quote.key === "stock" && entry.unit === "quote" ? (
                <p className={helper}>
                  {t("price.noUsd", { symbol: quote.symbol })}
                </p>
              ) : null}
              {fdvPreview !== null && tokensPerEth !== null ? (
                <p className="rounded-xl border border-line bg-paper px-4 py-3 text-sm text-body">
                  {t.rich(isBrandQuote ? "price.opensAtMillion" : "price.opensAt", {
                    cap: cap(fdvPreview).main,
                    detail: cap(fdvPreview).detail,
                    symbol: quote.symbol,
                    tokens: fmtCompact(tokensPerEth * (isBrandQuote ? 1e6 : 1), 0),
                    b: (chunks) => <span className="font-mono font-bold text-ink tnum">{chunks}</span>,
                    muted: (chunks) => <span className="font-mono text-muted tnum">{chunks}</span>,
                  })}
                </p>
              ) : null}
            </section>
          </Step>

          {/* 4 · fees */}
          <Step n={4} done={done.fees}>
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
                        <input className={`${input} font-mono ${burn ? "pr-20" : ""}`} value={r.payout} onChange={(e) => setRow(i, { payout: e.target.value.trim() })} placeholder="0x…" aria-label={t("split.address", { n: i + 1 })} autoComplete="off" spellCheck={false} />
                        {burn ? <span className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full border border-warm/30 bg-warm-soft px-2 h-6 inline-flex items-center text-[11px] font-medium text-warm-ink pointer-events-none">{t("split.burned")}</span> : null}
                      </div>
                      <div className="flex gap-2">
                        <div className="relative w-28 shrink-0">
                          <input className={`${input} font-mono tnum pr-8`} value={r.pct} onChange={(e) => setRow(i, { pct: e.target.value.trim() })} placeholder="0" inputMode="decimal" aria-label={t("split.share", { n: i + 1 })} />
                          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted pointer-events-none" aria-hidden>%</span>
                        </div>
                        <button type="button" className={`${btn.icon} h-12 w-12 shrink-0`} onClick={() => removeRow(i)} aria-label={t("split.remove", { n: i + 1 })} disabled={rows.length === 1 && !r.payout && !r.pct}>
                          ×
                        </button>
                      </div>
                    </div>
                  );
                })}
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className={btn.secondarySm} onClick={() => addRow()} disabled={rows.length >= MAX_RECIPIENTS}>
                    {t("split.add")}
                  </button>
                  {address && !hasRow(address) ? (
                    <button type="button" className={btn.secondarySm} onClick={() => quickAdd(address)} disabled={rows.length >= MAX_RECIPIENTS && rows.every((x) => x.payout.trim() !== "")}>
                      {t("split.addMe", { address: shortAddr(address) })}
                    </button>
                  ) : null}
                  {!hasRow(DEAD) ? (
                    <button type="button" className={btn.secondarySm} onClick={() => quickAdd(DEAD)} disabled={rows.length >= MAX_RECIPIENTS && rows.every((x) => x.payout.trim() !== "")}>
                      {t("split.addBurn")}
                    </button>
                  ) : null}
                  <span className={`ml-auto text-xs tnum ${split.remainingBps === 0 ? "text-up" : "text-warm-ink"}`}>
                    {split.remainingBps === 0 ? t("split.complete") : split.remainingBps > 0 ? t("split.left", { pct: bpsToPct(split.remainingBps) }) : t("split.over", { pct: bpsToPct(-split.remainingBps) })}
                  </span>
                </div>
                <p className={helper}>{t("split.help")}</p>
              </div>
            </LaunchFeeSettings>
          </Step>

          {/* 5 · first buy */}
          <Step n={5} done={done.buy}>
            <section className={`${card} p-5 space-y-4`}>
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <h2 className="text-sm font-semibold text-ink">
                  {t("buy.heading")} <span className="font-normal text-muted">{buySource === "suggested" ? t("suggested") : t("optional")}</span>
                </h2>
                <span className="text-xs text-muted">{t("buy.note")}</span>
              </div>
              {BUY_PRESETS[quote.key].length ? (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {BUY_PRESETS[quote.key].map((v) => {
                    const active = initialBuy.trim() === v;
                    return (
                      <button type="button" key={v} onClick={() => (active ? declineFirstBuy() : chooseFirstBuy(v))} aria-pressed={active} className={`${choice} ${active ? choiceOn : choiceOff}`}>
                        <span className="block truncate font-mono text-[15px] font-bold tnum">{fmtQuoteUnits(Number(v), quote.decimals)} {quote.symbol}</span>
                        {quoteUsd ? <span className={`mt-0.5 block truncate font-mono text-[11px] tnum ${active ? "text-brand" : "text-muted"}`}>≈ {fmtUsd(Number(v) * quoteUsd)}</span> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <input
                    className={`${input} h-11 w-44 font-mono pr-16`}
                    value={initialBuy}
                    onChange={(e) => { const next = resolveFirstBuyInput(e.target.value); if (next.kind === "choose") chooseFirstBuy(next.value); else if (next.kind === "decline") declineFirstBuy(); }}
                    placeholder={t("buy.placeholder")}
                    inputMode="decimal"
                    aria-label={t("buy.amountLabel", { symbol: quote.symbol })}
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono text-muted">{quote.symbol}</span>
                </div>
                {initialBuyRaw ? <button type="button" onClick={() => declineFirstBuy(true)} className={btn.secondarySm}>{t("buy.decline")}</button> : null}
                {initialBuyRaw && buyBalance !== undefined ? (
                  <span className="ml-auto text-xs font-mono text-muted tnum">{t("buy.balance", { amount: fmtQuoteUnits(units(buyBalance, quote.decimals), quote.decimals) })}</span>
                ) : null}
              </div>
              {buyPreview ? (
                <div className="rounded-xl border border-line bg-paper px-4 py-3">
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <div className="min-w-0">
                      <dt className="text-[11px] text-muted">{t("buy.estimateLabel")}</dt>
                      <dd className="mt-0.5 text-sm text-body">
                        {t.rich(buyUsd ? "buy.estimateUsd" : "buy.estimate", {
                          amount: fmtCompact(buyPreview.tokensOut, 0),
                          symbol: symbolClean || t("buy.tokens"),
                          share: fmtPct(buyPreview.pctOfSupply),
                          usd: buyUsd ? fmtUsd(buyUsd) : "",
                          b: (chunks) => <span className="font-mono font-bold text-ink tnum">{chunks}</span>,
                          sym: (chunks) => <span className="break-all">{chunks}</span>,
                          muted: (chunks) => <span className="font-mono text-muted tnum">{chunks}</span>,
                        })}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-[11px] text-muted">{t("buy.capAfterLabel")}</dt>
                      <dd className="mt-0.5 text-sm">
                        <span className="font-mono font-bold text-ink tnum">{cap(buyPreview.fdvAfter).main}</span><span className="font-mono text-muted tnum"> · {cap(buyPreview.fdvAfter).detail}</span>
                      </dd>
                    </div>
                  </dl>
                  <p className={helper}>{t("buy.estimateHelp")}</p>
                </div>
              ) : suggestion.reason === "not-issued" ? (
                <p className={helper}>{t("buy.notIssued", { symbol: quote.symbol })}</p>
              ) : suggestion.reason === "insufficient" ? (
                <p className={helper}>{t(sharedGas ? "buy.notEnough" : "buy.onlyGas", { amount: fmtQuoteUnits(Number(defaultFirstBuy(quote)), quote.decimals), symbol: quote.symbol })}</p>
              ) : suggestion.reason === "no-gas" ? (
                <p className={helper}>{t("buy.noGas", { amount: fmtQuoteUnits(Number(defaultFirstBuy(quote)), quote.decimals), symbol: quote.symbol, native: NATIVE_SYMBOL })}</p>
              ) : suggestion.reason === "unknown-balance" ? (
                <p className={helper}>{t("buy.unknownBalance")}</p>
              ) : suggestion.reason === "declined" && !typedBuy ? (
                <p className={helper}>{defaultFirstBuy(quote) ? t.rich("buy.declinedAgain", { amount: fmtQuoteUnits(Number(defaultFirstBuy(quote)), quote.decimals), symbol: quote.symbol, again: (chunks) => <button type="button" onClick={suggestAgain} className="font-medium text-brand underline underline-offset-4 hover:text-ink">{chunks}</button> }) : t("buy.declined")}</p>
              ) : null}
              <p className={helper}>{t("buy.why")}</p>
              <p className={helper}>{t("buy.slippage", { pct: FIRST_BUY_SLIPPAGE_BPS / 100 })}</p>
            </section>
          </Step>

          {/* 6 · launch */}
          <Step n={6} done={false} last icon={<Rocket size={14} strokeWidth={2.2} />}>
            <section className={`${card} p-5 space-y-4`}>
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <h2 className="text-sm font-semibold text-ink">{t("launch.heading")}</h2>
                <span className="text-xs text-muted">{t("launch.note")}</span>
              </div>
              <ul className="space-y-2.5 text-[13px] text-body">
                {[
                  [t("launch.deploy"), t("launch.deployDetail")],
                  [t("launch.pool"), t("launch.poolDetail", { quote: quote.symbol, chain: CHAIN_LABELS[chain] })],
                  [t("launch.lock"), t("launch.lockDetail")],
                  [t("launch.fees"), feePips === 0 ? t("launch.feesNone") : feeMode === "burn" ? t("launch.feesBurned") : recipients.length === 0 ? t("launch.feesNamed") : t("launch.feesShares", { shares: describeShares(recipients, shortAddr) })],
                  ...(initialBuyRaw ? [[t("launch.buy"), t("launch.buyDetail", { amount: initialBuyLabel })]] : []),
                ].map(([title, detail]) => (
                  <li key={title} className="flex gap-2.5">
                    <Check size={14} strokeWidth={2.5} aria-hidden className="mt-0.5 shrink-0 text-up" />
                    <span>
                      <span className="font-medium text-ink">{title}</span> <span className="text-muted">{detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <div className="border-t border-line pt-4 lg:hidden">{action}</div>
              <p className="text-xs text-muted leading-relaxed">
                {initialBuyRaw
                  ? t(quote.key !== "eth" ? "launch.summaryBuyApproval" : "launch.summaryBuy", { chain: CHAIN_LABEL, quote: quote.symbol, amount: initialBuyLabel })
                  : t("launch.summary", { chain: CHAIN_LABEL, quote: quote.symbol })}
              </p>
            </section>
          </Step>
        </ol>
      </form>

      {/* the console: the preview, what the launch sets, and on wide screens the launch button, always in reach */}
      <aside className="lg:sticky lg:top-20 min-w-0 order-first lg:order-none">
        <div className={`${card} p-4`}>
          <LaunchPreview row={previewRow} />
          <div className="mt-4 flex items-center justify-between gap-2 border-t border-line pt-4">
            <p className="text-xs font-medium text-ink">{t("console.atLaunch")}</p>
            <span className="flex items-center gap-1.5">
              <QuoteBrandBadge quoteKey={quote.key} size="md" />
              <FeeChip lpFee={feePips} mode={feeMode} />
            </span>
          </div>
          {/* hairlines between the tiles come from the gap over a line-coloured grid */}
          <dl className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line">
            <Mini k={t("console.opensAt")} v={fdvPreview !== null ? cap(fdvPreview).main : "—"} sub={fdvPreview !== null ? cap(fdvPreview).detail : CHAIN_LABELS[chain]} />
            <Mini k={buySource === "suggested" ? t("console.firstBuySuggested") : t("console.firstBuy")} v={initialBuyRaw ? initialBuyLabel : t("console.none")} sub={buyPreview ? t("console.ofSupply", { pct: fmtPct(buyPreview.pctOfSupply) }) : t("console.untouched")} />
            <Mini k={t("console.tradingFee")} v={FEE_PRESETS.find((f) => f.pips === feePips)?.label ?? "—"} sub={feeRouteSub} />
            <Mini k={t("console.platformFee")} v="0" sub={t("console.always")} accent />
          </dl>
          <div className="mt-4 hidden border-t border-line pt-4 lg:block">{action}</div>
        </div>
      </aside>
      {pickerOpen ? <WalletPicker onClose={() => setPickerOpen(false)} /> : null}
    </div>
  );
}

/** A selectable preset (market cap, first buy): its figure over a caption; the picked one takes the brand tint. */
const choice = "min-w-0 rounded-xl border px-3 py-2.5 text-left transition-colors motion-reduce:transition-none";
const choiceOn = "border-brand bg-brand-soft text-brand";
const choiceOff = "border-line-strong bg-card text-ink hover:border-ink/40";

function Mini({ k, v, sub, accent }: { k: string; v: string; sub?: string | null; accent?: boolean }) {
  return (
    <div className="min-w-0 bg-card px-3 py-2.5">
      <dt className="text-[11px] text-muted truncate">{k}</dt>
      <dd className={`font-mono font-bold text-sm tnum truncate ${accent ? "text-up" : "text-ink"}`}>{v}</dd>
      {sub ? <dd className="text-[11px] text-muted truncate">{sub}</dd> : null}
    </div>
  );
}

/**
 * One step of the launch sequence: its number on a rail beside the card (a check once the step is complete), then the
 * card. The rail runs from node to node and turns green behind a completed step; phones drop it for the width.
 */
function Step({ n, done, last = false, icon, children }: { n: number; done: boolean; last?: boolean; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="sm:grid sm:grid-cols-[2rem_minmax(0,1fr)] sm:gap-4">
      <div aria-hidden="true" className="relative hidden sm:block">
        {last ? null : <span className={`absolute left-1/2 top-12 -bottom-9 w-px -translate-x-1/2 transition-colors duration-300 motion-reduce:transition-none ${done ? "bg-up/50" : "bg-line-strong"}`} />}
        <span className={`relative mt-4 grid size-8 place-items-center rounded-full border text-xs font-semibold tnum transition-colors duration-300 motion-reduce:transition-none ${done ? "border-up/40 bg-up-soft text-up" : icon ? "border-brand/40 bg-brand-soft text-brand" : "border-line-strong bg-card text-muted"}`}>
          {done ? <Check size={14} strokeWidth={2.6} /> : (icon ?? n)}
        </span>
      </div>
      <div className="min-w-0">{children}</div>
    </li>
  );
}

/** A quote's mark in the picker: the bundled logo where there is one, a plain glyph for the rest. */
function QuoteMark({ k }: { k: Quote["key"] }) {
  if (k === "twig") return <TwigMark size={14} className="rounded-[3px]" />;
  if (k === "gitlawb") return <GitlawbMark size={14} className="rounded-[3px]" />;
  if (k === "stock") return <ChartCandlestick size={14} aria-hidden="true" className="shrink-0" />;
  if (k === "eth" || k === "usdc") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={k === "eth" ? "/brand/ethereum.svg" : "/brand/usdc.svg"} alt="" width={14} height={14} className="shrink-0" />;
  }
  return <CircleDollarSign size={14} aria-hidden="true" className="shrink-0" />;
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
  const t = useTranslations("launch.form.submit");
  const cls = `${btn.primary} bb-sheen relative overflow-hidden w-full min-h-12 text-[15px]`;
  if (!configured)
    return (
      <button type="button" disabled className={cls}>
        {t("notConfigured")}
      </button>
    );
  if (!connected)
    return (
      <button type="button" onClick={onConnect} disabled={connecting} className={cls}>
        {connecting ? t("connecting") : t("connect")}
      </button>
    );
  if (!onChain)
    return (
      <button type="button" onClick={onSwitch} disabled={connecting} className={`${btn.warm} w-full min-h-12 text-[15px]`}>
        {connecting ? t("switching") : t("switchTo", { chain: chainLabel })}
      </button>
    );
  const busyLabel: Partial<Record<Phase["k"], string>> = {
    saving: t("saving"),
    simulating: t("simulating"),
    signing: t("signing"),
    sent: t("sent", { chain: chainLabel }),
    buying: t("buying"),
    indexing: t("indexing"),
    done: t("done"),
  };
  const busy = busyLabel[phase.k];
  return (
    <button type="submit" form="launch-form" disabled={!valid || Boolean(busy)} className={cls}>
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
  const t = useTranslations("launch.form.phase");
  const explain = useReason();
  if (phase.k === "error")
    return (
      <p className="rounded-xl bg-down-soft border border-down/20 text-down-ink text-sm px-3 py-2" role="alert">
        {explain(phase.message)}
      </p>
    );
  if (phase.k === "sent" || phase.k === "buying" || phase.k === "indexing" || phase.k === "done") {
    // the transaction the line is about: the buy once it is sent, else the launch
    const hash = phase.k === "buying" && phase.step === "sent" ? phase.buyHash : phase.hash;
    const note = phase.k === "done" ? "txDone" : phase.k === "buying" ? (phase.step === "quote" ? "buyQuote" : phase.step === "approve" ? "buyApprove" : phase.step === "sign" ? "buySign" : "buySent") : "txSent";
    return (
      <p className="text-xs text-muted">
        {t.rich(note, {
          hash: `${hash.slice(0, 10)}…`,
          tx: (chunks) => <a href={explorerTx(chain, hash)} target="_blank" rel="noreferrer" className="font-code underline underline-offset-2 hover:text-ink">{chunks}</a>,
        })}
      </p>
    );
  }
  return null;
}
