"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useConfig, useReadContract, useReadContracts } from "wagmi";
import { useHydratedAccount } from "@/lib/useHydratedAccount";
import { getPublicClient, getWalletClient } from "wagmi/actions";
import { type Address, type Hex } from "viem";
import { btn } from "@/components/ui";
import { toast } from "./TxToasts";
import { QUOTE_VAULT_ABI } from "@/lib/launchpad/quote-abi";
import { feeContractForLaunch, isQuoteFeeLaunch, type LaunchIdentity } from "@/lib/launchpad/suites";
import { claimRequest, claimableContracts, collectRequest, type FeeTarget } from "@/lib/launchpad/fee-actions";
import { DEAD, quoteUsdOf, type Quote } from "@/lib/launchpad/config";
import { fmtQuote, fmtTokens, fmtUsd, pipsToPct } from "@/lib/launchpad/math";
import { CHAINS, explorerAddress, explorerTx, shortAddr, type ChainKey } from "@/lib/chainPublic";
import { WhoName } from "@/components/profile/Who";
import { friendlyError } from "@/lib/errors";
import { feeSidesUsd } from "@/lib/launchpad/creator";
import { feeModeOf } from "./FeeChip";
import { Spinner } from "@/components/Skeleton";

/**
 * Fee routing card: who gets the trading fee, what has been collected / burned
 * so far, and the permissionless `collect` + `claim` buttons. Collect pulls
 * accrued fees out of the pool for everyone at once; claim withdraws the
 * caller's own credited balance. Legacy fees use both currencies; quote-only
 * launches collect and claim quote fees from their immutable vault.
 */
export default function CollectPanel({
  launchIdentity,
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
  launchIdentity?: LaunchIdentity;
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
  const { address, chainId } = useHydratedAccount();
  const CHAIN = CHAINS[chain];
  const identity = launchIdentity ?? { chain };
  const quoteOnly = isQuoteFeeLaunch(identity);
  const LOCKER_ADDRESS = feeContractForLaunch(identity);
  const target: FeeTarget | null = LOCKER_ADDRESS ? { launch: identity, feeContract: LOCKER_ADDRESS, tokenId: BigInt(tokenId) } : null;
  const quoteUsd = quoteUsdOf(quote, ethUsd);
  const [phase, setPhase] = useState<{ k: "idle" } | { k: "busy"; what: "collect" | "claim"; currency?: Address } | { k: "sent"; hash: Hex; what: "collect" | "claim"; currency?: Address } | { k: "error"; message: string }>({ k: "idle" });

  const pending = useReadContract({
    address: LOCKER_ADDRESS ?? undefined,
    chainId: CHAIN.id,
    abi: QUOTE_VAULT_ABI,
    functionName: "pendingFees",
    args: [BigInt(tokenId)],
    query: { enabled: Boolean(quoteOnly && LOCKER_ADDRESS), refetchInterval: 20_000 },
  });

  // Legacy credits use both currencies; quote-only credits belong to this launch.
  const mine = useReadContracts({
    contracts: target && address ? claimableContracts(target, CHAIN.id, address, quote.address, token) : [],
    query: { enabled: Boolean(address && target), refetchInterval: 20_000 },
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
    if (!target || !address) return;
    try {
      setPhase({ k: "busy", what, currency });
      const pub = getPublicClient(config, { chainId: CHAIN.id })!;
      const wallet = await getWalletClient(config, { chainId: CHAIN.id });
      const request = what === "collect" ? await collectRequest(pub, target, address) : await claimRequest(pub, target, address, currency ?? quote.address);
      const hash: Hex = await wallet.writeContract(request);
      setPhase({ k: "sent", hash, what, currency });
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Transaction reverted on-chain.");
      await fetch(`/api/launch/sync?chain=${chain}&tx=${hash}`, { method: "POST" }).catch(() => {});
      void mine.refetch();
      if (quoteOnly) void pending.refetch();
      router.refresh();
      toast({ kind: "collect", title: what === "collect" ? `Fees collected for ${symbol}` : "Claimed", sub: what === "claim" ? "Paid to your wallet" : isBurnOnly ? "Burned on the spot" : "Allocated to the beneficiaries" });
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
    <section className="rounded-2xl border border-line bg-card p-5 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">Where the fees go</h2>
        <span className="font-mono font-bold text-ink tnum">{pipsToPct(lpFee)}{quoteOnly ? ` in ${quote.symbol}` : ""}</span>
      </div>

      {lpFee === 0 ? (
        <p className="text-sm text-body">This pool charges no fee. Nobody earns from trades, including the creator and us.</p>
      ) : (
        <>
          <ul className="space-y-1.5">
            {isBurnOnly && recipients.length === 0 ? <li className="flex items-center justify-between text-sm"><span className="text-warm-ink">Burned</span><span className="font-mono text-body tnum">100%</span></li> : null}
            {recipients.map((r, index) => {
              const burn = r.payout.toLowerCase() === DEAD.toLowerCase();
              return (
                <li key={`${r.payout}:${index}`} className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className={`h-2 w-2 rounded-full shrink-0 ${burn ? "bg-warm" : "bg-brand"}`} aria-hidden />
                    {burn ? (
                      <span className="text-warm-ink font-medium">Burned</span>
                    ) : (
                      address && r.payout.toLowerCase() === address.toLowerCase() ? (
                        <a href={explorerAddress(chain, r.payout)} target="_blank" rel="noreferrer" className="font-code text-ink hover:underline underline-offset-2 truncate">You</a>
                      ) : (
                        <WhoName address={r.payout} explorer={explorerAddress(chain, r.payout)} fallback={<a href={explorerAddress(chain, r.payout)} target="_blank" rel="noreferrer" className="font-code text-ink hover:underline underline-offset-2 truncate">{shortAddr(r.payout)}</a>} />
                      )
                    )}
                  </span>
                  <span className="font-mono tnum text-body">{(r.bps / 100).toFixed(r.bps % 100 === 0 ? 0 : 2)}%</span>
                </li>
              );
            })}
          </ul>
          <dl className="grid grid-cols-2 gap-2 pt-1">
            {quoteOnly ? (
              <div className="col-span-2 rounded-xl bg-paper border border-line px-3 py-2.5">
                <dt className="text-[11px] text-muted">Awaiting collection</dt>
                <dd className="font-mono font-bold text-sm tnum text-ink break-words">{pending.isError ? "Unavailable" : pending.data === undefined ? "Reading…" : fq(pending.data)}</dd>
              </div>
            ) : null}
            <div className="min-w-0 rounded-xl bg-paper border border-line px-3 py-2.5">
              <dt className="text-[11px] text-muted">{isBurnOnly ? "Burned so far" : "Collected so far"}</dt>
              <dd className="font-mono font-bold text-sm tnum text-ink break-words">{fq(isBurnOnly ? burned.quote : collected.quote)}</dd>
              {!quoteOnly ? <dd className="font-mono font-bold text-sm tnum text-ink break-words">{ft(isBurnOnly ? burned.token : collected.token)}</dd> : null}
              {usd(isBurnOnly ? burned : collected) ? <dd className="text-[11px] font-mono text-muted tnum">{usd(isBurnOnly ? burned : collected)}</dd> : null}
            </div>
            <div className="min-w-0 rounded-xl bg-paper border border-line px-3 py-2.5">
              <dt className="text-[11px] text-muted">{isBurnOnly ? "Where it went" : "Burned"}</dt>
              {isBurnOnly ? (
                <dd className="text-[11px] text-body leading-relaxed">{quoteOnly ? quote.symbol : "Both sides"} sent to the dead address. Nobody can claim them.</dd>
              ) : (
                <>
                  {/* amber only once something has actually burned; zero reads as the plain fact it is */}
                  <dd className={`font-mono font-bold text-sm tnum break-words ${burned.quote > 0n ? "text-warm-ink" : "text-muted"}`}>{fq(burned.quote)}</dd>
                  {!quoteOnly ? <dd className={`font-mono font-bold text-sm tnum break-words ${burned.token > 0n ? "text-warm-ink" : "text-muted"}`}>{ft(burned.token)}</dd> : null}
                </>
              )}
            </div>
            {!isBurnOnly ? (
              <div className="col-span-2 rounded-xl bg-paper border border-line px-3 py-2.5">
                <dt className="text-[11px] text-muted">Allocated to beneficiaries</dt>
                <dd className="font-mono font-bold text-sm tnum text-ink break-words">{fq(toPeople.quote)}{!quoteOnly ? <> <span className="text-muted" aria-hidden>+</span> {ft(toPeople.token)}</> : null}</dd>
                {usd(toPeople) ? <dd className="text-[11px] font-mono text-muted tnum">{usd(toPeople)}</dd> : null}
              </div>
            ) : null}
          </dl>
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" onClick={() => void send("collect")} disabled={busy || !address || !onChain || !LOCKER_ADDRESS} className={`${btn.secondarySm} flex-1`}>
              {phase.k === "busy" && phase.what === "collect" ? <><Spinner size={13} /> Collecting…</> : phase.k === "sent" && phase.what === "collect" ? <><Spinner size={13} /> Confirming…</> : "Collect fees"}
            </button>
            {claims.map((c) => (
              <button key={c.currency} type="button" onClick={() => void send("claim", c.currency)} disabled={busy || !onChain} className={`${btn.secondarySm} flex-1`} title="A payout to you could not be delivered and was credited instead">
                {phase.k === "busy" && phase.what === "claim" && phase.currency === c.currency ? <><Spinner size={13} /> Claiming…</> : phase.k === "sent" && phase.what === "claim" && phase.currency === c.currency ? <><Spinner size={13} /> Confirming…</> : `Claim ${c.label(c.raw)}`}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted leading-relaxed">
            Anyone can collect. Collecting pulls accrued fees out of the pool and {isBurnOnly ? "burns them on the spot" : "distributes them to the beneficiaries. Failed payouts stay claimable"}. Liquidity never moves.
          </p>
        </>
      )}
      {phase.k === "error" ? (
        <p className="rounded-xl bg-down-soft border border-down/20 text-down-ink text-xs px-3 py-2" role="alert">
          {phase.message}
        </p>
      ) : null}
      {phase.k === "sent" ? (
        <p className="text-[11px] text-muted">
          tx{" "}
          <a href={explorerTx(chain, phase.hash)} target="_blank" rel="noreferrer" className="font-code underline underline-offset-2">
            {phase.hash.slice(0, 10)}…
          </a>
        </p>
      ) : null}
    </section>
  );
}
