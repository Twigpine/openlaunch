"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useConfig, useReadContracts } from "wagmi";
import { getPublicClient, getWalletClient } from "wagmi/actions";
import { type Address, type Hex } from "viem";
import { btn } from "@/components/ui";
import { toast } from "./TxToasts";
import { LAUNCH_LOCKER_ABI } from "@/lib/launchpad/abi";
import { DEAD, launchpad, quoteUsdOf, type Quote } from "@/lib/launchpad/config";
import { fmtQuote, fmtTokens, fmtUsd, pipsToPct } from "@/lib/launchpad/math";
import { BUILDER_DATA_SUFFIX, CHAINS, explorerAddress, explorerTx, shortAddr, type ChainKey } from "@/lib/chainPublic";
import { friendlyError } from "@/lib/errors";
import { feeSidesUsd } from "@/lib/launchpad/creator";
import { feeModeOf } from "./FeeChip";
import { Spinner } from "@/components/Skeleton";

/**
 * Fee routing card: who gets the trading fee, what has been collected / burned
 * so far, and the permissionless `collect` + `claim` buttons. Collect pulls
 * accrued fees out of the pool for everyone at once; claim withdraws the
 * caller's own credited balance. Fees accrue on both sides of the pool (quote
 * from buys, the launched token from sells), so totals and claims show both.
 */
export default function CollectPanel({
  chain,
  quote,
  token,
  tokenId,
  symbol,
  lpFee,
  recipients,
  collectedQuote,
  collectedToken,
  burnedQuote,
  burnedToken,
  priceQuote,
  ethUsd,
}: {
  chain: ChainKey;
  quote: Quote;
  token: Address;
  tokenId: number;
  symbol: string;
  lpFee: number;
  recipients: { payout: string; bps: number }[];
  collectedQuote: string;
  collectedToken: string;
  burnedQuote: string;
  burnedToken: string;
  priceQuote: number;
  ethUsd: number | null;
}) {
  const router = useRouter();
  const config = useConfig();
  const { address, chainId } = useAccount();
  const CHAIN = CHAINS[chain];
  const LOCKER_ADDRESS = launchpad(chain).locker;
  const quoteUsd = quoteUsdOf(quote, ethUsd);
  const [phase, setPhase] = useState<{ k: "idle" } | { k: "busy"; what: "collect" | "claim"; currency?: Address } | { k: "sent"; hash: Hex; what: "collect" | "claim"; currency?: Address } | { k: "error"; message: string }>({ k: "idle" });

  // Credited balances on both sides: [quote, launched token].
  const mine = useReadContracts({
    contracts: [quote.address, token].map((currency) => ({
      address: LOCKER_ADDRESS ?? undefined,
      chainId: CHAIN.id,
      abi: LAUNCH_LOCKER_ABI,
      functionName: "claimable" as const,
      args: address ? ([address, currency] as const) : undefined,
    })),
    query: { enabled: Boolean(address && LOCKER_ADDRESS), refetchInterval: 20_000 },
  });

  const isBurnOnly = feeModeOf(lpFee, recipients) === "burn";
  const collected = { quote: BigInt(collectedQuote), token: BigInt(collectedToken) };
  const burned = { quote: BigInt(burnedQuote), token: BigInt(burnedToken) };
  const toPeople = { quote: collected.quote - burned.quote, token: collected.token - burned.token };
  // Token side is valued at the current pool price, so any USD total that includes it is an estimate.
  const usd = (sides: { quote: bigint; token: bigint }) => {
    const v = feeSidesUsd(sides, quote.decimals, priceQuote, quoteUsd);
    return v === null ? null : `${sides.token > 0n ? "≈ " : ""}${fmtUsd(v)}`;
  };
  const fq = (raw: bigint) => fmtQuote(raw, quote.decimals, quote.symbol);
  const ft = (raw: bigint) => `${fmtTokens(raw)} ${symbol}`;

  async function send(what: "collect" | "claim", currency?: Address) {
    if (!LOCKER_ADDRESS || !address) return;
    try {
      setPhase({ k: "busy", what, currency });
      const pub = getPublicClient(config, { chainId: CHAIN.id })!;
      const wallet = await getWalletClient(config, { chainId: CHAIN.id });
      let hash: Hex;
      if (what === "collect") {
        const { request } = await pub.simulateContract({ address: LOCKER_ADDRESS, abi: LAUNCH_LOCKER_ABI, functionName: "collect", args: [BigInt(tokenId)], account: address, dataSuffix: BUILDER_DATA_SUFFIX });
        hash = await wallet.writeContract(request);
      } else {
        const { request } = await pub.simulateContract({ address: LOCKER_ADDRESS, abi: LAUNCH_LOCKER_ABI, functionName: "claim", args: [currency ?? quote.address], account: address, dataSuffix: BUILDER_DATA_SUFFIX });
        hash = await wallet.writeContract(request);
      }
      setPhase({ k: "sent", hash, what, currency });
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Transaction reverted on-chain.");
      await fetch(`/api/launch/sync?chain=${chain}&tx=${hash}`, { method: "POST" }).catch(() => {});
      void mine.refetch();
      router.refresh();
      toast({ kind: "collect", title: what === "collect" ? `Fees collected for ${symbol}` : "Claimed", sub: isBurnOnly ? "Burned on the spot" : "Paid to the beneficiaries" });
      setPhase({ k: "idle" });
    } catch (err) {
      setPhase({ k: "error", message: friendlyError(err) });
    }
  }

  const busy = phase.k === "busy" || phase.k === "sent";
  const onChain = chainId === CHAIN.id;
  const claims = [
    { currency: quote.address, raw: (mine.data?.[0]?.result as bigint | undefined) ?? 0n, label: fq },
    { currency: token, raw: (mine.data?.[1]?.result as bigint | undefined) ?? 0n, label: ft },
  ].filter((c) => c.raw > 0n);

  return (
    <section className="space-y-4 border-t border-line pt-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">Where the fees go</h2>
        <span className="font-mono font-bold text-ink tnum">{pipsToPct(lpFee)}</span>
      </div>

      {lpFee === 0 ? (
        <p className="text-sm text-body">This pool charges no fee. Nobody earns from trades, including the creator and us.</p>
      ) : (
        <>
          <ul className="space-y-1.5">
            {isBurnOnly && recipients.length === 0 ? <li className="flex items-center justify-between text-sm"><span className="text-warm-ink">Burned</span><span className="font-mono text-body tnum">100%</span></li> : null}
            {recipients.map((r) => {
              const burn = r.payout.toLowerCase() === DEAD.toLowerCase();
              return (
                <li key={r.payout} className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className={`h-2 w-2 rounded-full shrink-0 ${burn ? "bg-warm" : "bg-brand"}`} aria-hidden />
                    {burn ? (
                      <span className="text-warm-ink font-medium">Burned</span>
                    ) : (
                      <a href={explorerAddress(chain, r.payout)} target="_blank" rel="noreferrer" className="font-mono text-ink hover:underline underline-offset-2 truncate">
                        {address && r.payout.toLowerCase() === address.toLowerCase() ? "You" : shortAddr(r.payout)}
                      </a>
                    )}
                  </span>
                  <span className="font-mono tnum text-body">{(r.bps / 100).toFixed(r.bps % 100 === 0 ? 0 : 2)}%</span>
                </li>
              );
            })}
          </ul>
          <dl className="grid grid-cols-2 gap-4 border-y border-line py-4">
            <div className="min-w-0 space-y-1">
              <dt className="text-[11px] text-muted">{isBurnOnly ? "Burned so far" : "Collected so far"}</dt>
              <dd className="break-words font-mono font-bold text-sm tnum text-ink">{fq(isBurnOnly ? burned.quote : collected.quote)}</dd>
              <dd className="break-words font-mono font-bold text-sm tnum text-ink">{ft(isBurnOnly ? burned.token : collected.token)}</dd>
              {usd(isBurnOnly ? burned : collected) ? <dd className="text-[11px] font-mono text-muted tnum">{usd(isBurnOnly ? burned : collected)}</dd> : null}
            </div>
            <div className="min-w-0 space-y-1 border-l border-line pl-4">
              <dt className="text-[11px] text-muted">{isBurnOnly ? "Where it went" : "Burned"}</dt>
              {isBurnOnly ? (
                <dd className="text-[11px] text-body leading-relaxed">Both sides sent to the dead address. Nobody can claim them.</dd>
              ) : (
                <>
                  <dd className="font-mono font-bold text-sm tnum text-warm-ink break-words">{fq(burned.quote)}</dd>
                  <dd className="font-mono font-bold text-sm tnum text-warm-ink break-words">{ft(burned.token)}</dd>
                </>
              )}
            </div>
            {!isBurnOnly ? (
              <div className="col-span-2 min-w-0 space-y-1 border-t border-line pt-4">
                <dt className="text-[11px] text-muted">Paid to beneficiaries</dt>
                <dd className="font-mono font-bold text-sm tnum text-ink break-words">{fq(toPeople.quote)} <span className="text-muted" aria-hidden>+</span> {ft(toPeople.token)}</dd>
                {usd(toPeople) ? <dd className="text-[11px] font-mono text-muted tnum">{usd(toPeople)}</dd> : null}
              </div>
            ) : null}
          </dl>
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" onClick={() => void send("collect")} disabled={busy || !address || !onChain} className={`${btn.secondarySm} flex-1`}>
              {phase.k === "busy" && phase.what === "collect" ? <><Spinner size={13} /> Collecting…</> : phase.k === "sent" && phase.what === "collect" ? <><Spinner size={13} /> Confirming…</> : "Collect fees"}
            </button>
            {claims.map((c) => (
              <button key={c.currency} type="button" onClick={() => void send("claim", c.currency)} disabled={busy || !onChain} className={`${btn.secondarySm} flex-1`} title="A payout to you could not be delivered and was credited instead">
                {phase.k === "busy" && phase.what === "claim" && phase.currency === c.currency ? <><Spinner size={13} /> Claiming…</> : phase.k === "sent" && phase.what === "claim" && phase.currency === c.currency ? <><Spinner size={13} /> Confirming…</> : `Claim ${c.label(c.raw)}`}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted leading-relaxed">
            Anyone can collect. Collecting pulls accrued fees out of the pool and {isBurnOnly ? "burns them on the spot" : "pays the beneficiaries directly, in the same transaction"}. Liquidity never moves.
          </p>
        </>
      )}
      {phase.k === "error" ? (
        <p className="rounded-lg bg-down-soft text-down-ink text-xs px-3 py-2" role="alert">
          {phase.message}
        </p>
      ) : null}
      {phase.k === "sent" ? (
        <p className="text-[11px] text-muted">
          tx{" "}
          <a href={explorerTx(chain, phase.hash)} target="_blank" rel="noreferrer" className="font-mono underline underline-offset-2">
            {phase.hash.slice(0, 10)}…
          </a>
        </p>
      ) : null}
    </section>
  );
}
