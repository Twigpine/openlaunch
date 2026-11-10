"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAccount, useConfig } from "wagmi";
import { getPublicClient } from "wagmi/actions";
import { erc20Abi, type Address } from "viem";
import { ArrowLeftRight, Check, X } from "lucide-react";
import { chainIdOf, type ChainKey } from "@/lib/chainPublic";
import { BRIDGE_CHAINS, isBridgeAssetSupported, isBridgeDestination, type BridgeAsset, type BridgeChainId, type BridgeDestinationId } from "@/lib/bridge/types";
import { SIGNAL_CODES, SIGNAL_COLORS } from "@/lib/bridge/signal";
import { formatHistoryAmount, historySettled, historyStatus, type BridgeHistoryEntry } from "@/lib/bridge/history";
import { bridgeHistoryKey } from "@/lib/bridge/history-store";
import { bridgeAssetForPay, followedBridge, formatFundAmount, fundStep, pickBridgeSource, readBridgeHoldings, type BridgeHolding, type FundStep } from "@/lib/bridge/fund";
import type { BridgeLink } from "@/lib/bridge/link";
import { useOpenBridge, useWakeBridge } from "./BridgeProvider";
import { bridgeLedger } from "./history-ledger";
import { dotFont } from "./dot-font";
import styles from "./Fund.module.css";

type Pay = { symbol: string; decimals: number; address: Address; native: boolean };
type Scan = { key: string; holdings: BridgeHolding[] | null };
const DISMISSED_KEY = "openlaunch.bridge.buy.dismissed";
const NO_ROWS: BridgeHistoryEntry[] = [];
const codeColor = (chain: BridgeChainId) => ({ "--code": SIGNAL_COLORS[chain].join(" ") }) as React.CSSProperties;

function readDismissed(): string[] {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(DISMISSED_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(-20) : [];
  } catch { return []; }
}

/**
 * "Bridge, then buy" in the token page's trade panel. When the buyer is short of what the buy pays with, it finds where
 * else the wallet holds funds and opens the bridge on that route; it then follows that transfer and says when the
 * funds have landed so the buy can go ahead. Two steps, never one: nothing here signs, sends or buys.
 */
export default function BridgeToBuy({ chain, symbol, pay, short, shortBy, ethUsd, onArrived }: { chain: ChainKey; symbol: string; pay: Pay; short: boolean; shortBy: bigint | null; ethUsd: number | null; onArrived: () => void }) {
  const chainId = chainIdOf(chain);
  const destination = isBridgeDestination(chainId) ? chainId : null;
  const asset = destination === null ? null : bridgeAssetForPay(destination, pay);
  if (destination === null || asset === null) return null;
  return <Follow destination={destination} asset={asset} symbol={symbol} pay={pay} short={short} shortBy={shortBy} ethUsd={ethUsd} onArrived={onArrived} />;
}

function Follow({ destination, asset, symbol, pay, short, shortBy, ethUsd, onArrived }: { destination: BridgeDestinationId; asset: BridgeAsset; symbol: string; pay: Pay; short: boolean; shortBy: bigint | null; ethUsd: number | null; onArrived: () => void }) {
  const config = useConfig();
  const { address } = useAccount();
  const wallet = address?.toLowerCase() ?? "";
  const openBridge = useOpenBridge();
  const wake = useWakeBridge();
  const snapshot = useSyncExternalStore(bridgeLedger.subscribe, bridgeLedger.getSnapshot, bridgeLedger.getServerSnapshot);
  const rows = snapshot.entries[wallet] ?? NO_ROWS;
  const [now, setNow] = useState(0);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [scan, setScan] = useState<Scan | null>(null);
  // looks already made or still out, by wallet and network, so one is never started twice
  const scans = useRef(new Map<string, Promise<BridgeHolding[]>>());
  const arrived = useRef("");

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const load = () => setDismissed(readDismissed());
    load();
    if (!address) return;
    bridgeLedger.read(address);
    const onStorage = (event: StorageEvent) => { if (event.key === null || event.key === bridgeHistoryKey(address)) bridgeLedger.read(address); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [address]);

  const row = now ? followedBridge(rows, destination, asset, now, dismissed) : null;
  const step = fundStep(row);
  const rowId = row?.requestId ?? "";
  const rowStatus = row?.status ?? null;

  // A followed transfer that has not settled keeps being tracked in the background, without opening the panel.
  useEffect(() => { if (rowStatus && !historySettled(rowStatus)) wake?.(); }, [rowStatus, wake]);
  // Funds landed: ask the trade panel to read its balance now rather than at its next interval.
  useEffect(() => {
    if (rowStatus !== "success" || arrived.current === rowId) return;
    arrived.current = rowId;
    onArrived();
  }, [rowId, rowStatus, onArrived]);

  // Look for funds elsewhere only while the buyer is short and no bridge is being followed. One look per wallet and
  // network: an amount edited back and forth across the balance reuses the look already made, or the one still out.
  const scanKey = wallet && short && step === "short" ? `${wallet}:${destination}` : "";
  // A followed bridge moves funds, so what was seen before it is stale: the next shortfall looks again.
  useEffect(() => { if (step !== "short") scans.current.clear(); }, [step]);
  useEffect(() => {
    if (!scanKey || !address) return;
    let stopped = false;
    let look = scans.current.get(scanKey);
    if (!look) {
      const client = (id: BridgeChainId) => {
        const pub = getPublicClient(config, { chainId: id });
        if (!pub) throw new Error("no client");
        return pub;
      };
      look = readBridgeHoldings({
        native: async (id, who) => client(id).getBalance({ address: who }),
        token: async (id, token, who) => client(id).readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] }),
      }, address, destination);
      scans.current.set(scanKey, look);
    }
    // a late result lands only while this wallet and network are still the ones asked about
    void look.then((holdings) => { if (!stopped) setScan({ key: scanKey, holdings }); });
    return () => { stopped = true; };
  }, [scanKey, address, config, destination]);

  if (!wallet || (step === "short" && !short)) return null;
  const holdings = scan?.key === scanKey ? scan.holdings : null;
  const suggestion = holdings ? pickBridgeSource(holdings, { chainId: destination, asset }, ethUsd) : null;
  const fallbackOrigin: BridgeChainId = destination === 8453 ? 1 : 8453;
  const link: BridgeLink = suggestion
    ? { originChainId: suggestion.chainId, destinationChainId: destination, originAsset: suggestion.asset, destinationAsset: asset }
    : { originChainId: fallbackOrigin, destinationChainId: destination, ...(isBridgeAssetSupported(fallbackOrigin, asset, "input") ? { originAsset: asset } : {}), destinationAsset: asset };
  const dismiss = () => {
    if (!row) return;
    const next = [...dismissed, row.requestId].slice(-20);
    setDismissed(next);
    try { window.sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(next)); } catch { /* dismissed for this view only */ }
  };

  return (
    <FundCard
      step={step} destination={destination} asset={asset} symbol={symbol} row={row}
      shortBy={shortBy !== null && shortBy > 0n ? `${formatFundAmount(shortBy, pay.decimals)} ${pay.symbol}` : null}
      suggestion={suggestion} searching={step === "short" && holdings === null}
      onBridge={() => openBridge?.(link)} onOpen={() => openBridge?.()} onDismiss={dismiss}
    />
  );
}

/** The card from plain props, so the development fixture can show every step without a wallet. */
export function FundCard({ step, destination, asset, symbol, row, shortBy, suggestion, searching, onBridge, onOpen, onDismiss }: {
  step: FundStep; destination: BridgeDestinationId; asset: BridgeAsset; symbol: string; row: BridgeHistoryEntry | null;
  shortBy: string | null; suggestion: BridgeHolding | null; searching: boolean; onBridge: () => void; onOpen: () => void; onDismiss: () => void;
}) {
  const to = BRIDGE_CHAINS[destination].name;
  const from: BridgeChainId | null = row?.originChainId ?? suggestion?.chainId ?? null;
  const word = step === "short" ? "Short" : step === "arrived" ? "Arrived" : row ? historyStatus(row).label : "";
  const received = row?.outKind === "received" && row.amountOut !== null ? `${formatHistoryAmount(row.amountOut, row.outDecimals)} ${row.destinationAsset}` : null;
  return (
    <section className={`${styles.fund} ${dotFont.variable}`} data-step={step} aria-label="Bridge, then buy">
      <div className={styles.head}>
        <div className={styles.plate} aria-hidden>
          {from !== null ? <span className={styles.code} style={codeColor(from)}>{SIGNAL_CODES[from]}</span> : <span className={styles.code} data-unknown>···</span>}
          <span className={styles.track} />
          <span className={styles.code} style={codeColor(destination)}>{SIGNAL_CODES[destination]}</span>
          <span className={styles.word}>{word}</span>
        </div>
        {row && step !== "moving" ? <button type="button" className={styles.dismiss} onClick={onDismiss} aria-label="Hide this bridge"><X size={15} aria-hidden /></button> : null}
      </div>
      <ol className={styles.steps}>
        <li data-state={step === "short" ? "active" : step === "arrived" ? "done" : step === "attention" ? "warn" : "active"}>
          <span className={styles.mark} aria-hidden>{step === "arrived" ? <Check size={12} strokeWidth={2.5} /> : "1"}</span>
          <div>
            <strong>{step === "arrived" ? `${row!.destinationAsset} arrived on ${to}` : `Bridge ${asset} to ${to}`}</strong>
            {step === "short" ? <>
              {shortBy ? <p>This buy needs {shortBy} more on {to}.</p> : <p>You have no {asset} on {to} yet.</p>}
              <p>{searching ? "Checking your other networks…" : suggestion ? `You have ${formatFundAmount(suggestion.amount, suggestion.decimals)} ${suggestion.asset} on ${BRIDGE_CHAINS[suggestion.chainId].name}.` : "No funds found on your other networks. You can still pick any route in the bridge."}</p>
              <button type="button" className={styles.action} onClick={onBridge}><ArrowLeftRight size={14} aria-hidden />{suggestion ? `Bridge from ${BRIDGE_CHAINS[suggestion.chainId].name}` : "Open the bridge"}</button>
            </> : step === "moving" ? <>
              <p role="status">{formatHistoryAmount(row!.amountIn, row!.inDecimals)} {row!.originAsset} from {BRIDGE_CHAINS[row!.originChainId].name} is {row!.status === "delayed" ? "taking longer than usual" : "on its way"}.</p>
              <button type="button" className={styles.link} onClick={onOpen}>Follow it in the bridge</button>
            </> : step === "attention" ? <>
              <p role="status">{historyStatus(row!).label}. Check this transfer in the bridge before sending again.</p>
              <button type="button" className={styles.link} onClick={onOpen}>Open the bridge</button>
            </> : <p role="status">{received ? `${received} delivered. ` : ""}Your balance here updates in a moment.</p>}
          </div>
        </li>
        <li data-state={step === "arrived" ? "active" : "waiting"}>
          <span className={styles.mark} aria-hidden>2</span>
          <div>
            <strong>Buy {symbol}</strong>
            <p>{step === "arrived" ? "Use the buy button above. It asks your wallet separately." : "Once the funds land, buy above. Bridging never buys for you."}</p>
          </div>
        </li>
      </ol>
    </section>
  );
}
