"use client";

import { useEffect, useRef, useState } from "react";
import { useConfig } from "wagmi";
import { getPublicClient } from "wagmi/actions";
import { erc20Abi, type Address } from "viem";
import type { BridgeHolding, HoldingReader } from "@/lib/bridge/fund";
import { EXCHANGE_OPEN_KEY, EXCHANGE_POLL_MS, EXCHANGE_WATCH_KEY, findExchangeArrivals, nextExchangeBaseline, parseExchangeWatch, readExchangeHoldings, serializeExchangeWatch, type ExchangeArrival, type ExchangeWatch } from "@/lib/bridge/exchange";
import type { BridgeChainId } from "@/lib/bridge/types";

/** What the guide shows about the watch: whether a first read is still out, whether reads fail, and what landed. */
export type ExchangeView = { checking: boolean; unreadable: boolean; arrivals: ExchangeArrival[] };
export const EXCHANGE_IDLE: ExchangeView = { checking: false, unreadable: false, arrivals: [] };

type Reading = { wallet: string; watch: ExchangeWatch; holdings: BridgeHolding[] };

function savedWatch(wallet: string, now: number): ExchangeWatch | null {
  try { return parseExchangeWatch(window.sessionStorage.getItem(EXCHANGE_WATCH_KEY), wallet, now); } catch { return null; }
}

/**
 * Reads the wallet's ETH and USDC on the exchange networks every few seconds while the guide is open, read-only, and
 * keeps the lowest balance seen in this tab so that what lands later stands out. Paused while the tab is hidden.
 */
export default function useExchangeWatch(address: Address | undefined): ExchangeView {
  const config = useConfig();
  const wallet = address?.toLowerCase() ?? "";
  const [reading, setReading] = useState<Reading | null>(null);
  const watchRef = useRef<ExchangeWatch | null>(null);

  useEffect(() => {
    if (!address) return;
    const key = address.toLowerCase();
    let stopped = false;
    let timer = 0;
    const client = (id: BridgeChainId) => {
      const pub = getPublicClient(config, { chainId: id });
      if (!pub) throw new Error("no client");
      return pub;
    };
    const read: HoldingReader = {
      native: async (id, who) => client(id).getBalance({ address: who }),
      token: async (id, token, who) => client(id).readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] }),
    };
    const tick = async () => {
      if (!document.hidden) {
        const holdings = await readExchangeHoldings(read, address);
        if (stopped) return;
        const now = Date.now();
        const saved = watchRef.current?.wallet === key ? watchRef.current : savedWatch(key, now) ?? { wallet: key, startedAt: now, baseline: {} };
        const watch = { ...saved, baseline: nextExchangeBaseline(saved.baseline, holdings) };
        watchRef.current = watch;
        try { window.sessionStorage.setItem(EXCHANGE_WATCH_KEY, serializeExchangeWatch(watch)); } catch { /* watched for this view only */ }
        setReading({ wallet: key, watch, holdings });
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), EXCHANGE_POLL_MS);
    };
    void tick();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [address, config]);

  if (!wallet) return EXCHANGE_IDLE;
  if (reading?.wallet !== wallet) return { checking: true, unreadable: false, arrivals: [] };
  return { checking: false, unreadable: reading.holdings.length === 0, arrivals: findExchangeArrivals(reading.watch.baseline, reading.holdings) };
}

/** Ends the watch: the guide was closed on purpose, or its funds were taken to the bridge. */
export function clearExchangeWatch() {
  try {
    window.sessionStorage.removeItem(EXCHANGE_WATCH_KEY);
    window.sessionStorage.removeItem(EXCHANGE_OPEN_KEY);
  } catch { /* nothing kept */ }
}
