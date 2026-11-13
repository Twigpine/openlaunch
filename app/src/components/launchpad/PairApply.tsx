"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useConfig } from "wagmi";
import { walletOnChain } from "@/lib/walletOnChain";
import { isAddress } from "viem";
import { useHydratedAccount } from "@/lib/useHydratedAccount";
import { btn, card, helper, input, label } from "@/components/ui";
import { CHAINS, CHAIN_LABELS, type ChainKey } from "@/lib/chainPublic";
import { nowMs } from "@/lib/launchpad/time";
import { nonce } from "@/lib/nonce";
import { friendlyError } from "@/lib/errors";
import { PAIR_CHAINS, PAIR_DESCRIPTION_MAX, PAIR_FEE_CHAIN } from "@/lib/launchpad/pairs";
import { PAIR_APPLY_COPY, buildPairApplyMessage, sourceLabel } from "@/lib/launchpad/pairApply";
import type { PairPrecheck } from "@/lib/launchpad/pairCheck";
import { ChainLogo } from "./ChainLogo";
import ImageUpload from "./ImageUpload";
import PrecheckReport from "./PrecheckReport";

/**
 * Apply to list a community pair: the token's chain, the free check first (anyone, no wallet), then, once it passes,
 * the application signed by a wallet with a verified X profile. Nothing is paid here: the fee is the next page's step,
 * in TWIG on Base whatever chain the token is on, and the signature is made on Base too (PAIR_FEE_CHAIN).
 */
export default function PairApply({ feeUsd }: { feeUsd: number }) {
  const router = useRouter();
  const config = useConfig();
  const { address } = useHydratedAccount();
  const [chain, setChain] = useState<ChainKey>(PAIR_CHAINS[0]);
  const [token, setToken] = useState("");
  const [check, setCheck] = useState<PairPrecheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [source, setSource] = useState(0);
  const [logo, setLogo] = useState("");
  const [website, setWebsite] = useState("");
  const [x, setX] = useState("");
  const [about, setAbout] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function pickChain(c: ChainKey) {
    if (c === chain) return;
    setChain(c);
    setCheck(null);
    setSource(0);
    setErr(null);
  }

  async function runCheck() {
    if (!isAddress(token.trim()) || checking) return;
    setChecking(true);
    setErr(null);
    setCheck(null);
    try {
      const res = await fetch("/api/pairs/precheck", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chain, address: token.trim() }) });
      const d = (await res.json().catch(() => ({}))) as PairPrecheck & { error?: string };
      if (!res.ok) throw new Error(d.error ?? `request failed (HTTP ${res.status})`);
      setCheck(d);
      setSource(0);
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setChecking(false);
    }
  }

  const usable = check?.sources.filter((s) => s.usable) ?? [];
  const picked = usable[source] ?? null;

  async function apply() {
    if (!address || !check?.ok || !picked || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const fields = { price_kind: picked.kind, price_pool: picked.pool, price_quote: picked.quote, price_hook: picked.hook, logo: logo.trim(), website: website.trim(), x_handle: x.trim().replace(/^@/, ""), description: about.trim() };
      const n = nonce();
      const ts = nowMs();
      const wallet = await walletOnChain(config, CHAINS[PAIR_FEE_CHAIN].id);
      const message = buildPairApplyMessage({ action: "apply", chain: check.chain, address: check.address, wallet: address, nonce: n, ts, source: sourceLabel(fields), website: fields.website, x_handle: fields.x_handle, logo: fields.logo, description: fields.description });
      const signature = await wallet.signMessage({ message });
      const res = await fetch("/api/pairs/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "apply", chain: check.chain, address: check.address, wallet: address, nonce: n, ts, signature, ...fields }) });
      const d = (await res.json().catch(() => ({}))) as { id?: number; error?: string };
      if (!res.ok || !d.id) throw new Error(d.error ?? `request failed (HTTP ${res.status})`);
      router.push(`/pairs/apply/${d.id}`);
    } catch (e) {
      setErr(friendlyError(e));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className={`${card} space-y-3 p-5`}>
        <p className="text-sm text-body">{PAIR_APPLY_COPY.whatYouGet}</p>
        <p className="text-sm text-body">{PAIR_APPLY_COPY.feeRule(feeUsd)}</p>
        <p className={helper}>{PAIR_APPLY_COPY.precheckFirst}</p>
      </div>
      <div className={`${card} space-y-3 p-5`}>
        <div>
          <p id="pair-chain" className={label}>Your token&apos;s chain</p>
          <div className="flex flex-wrap gap-2" role="group" aria-labelledby="pair-chain">
            {PAIR_CHAINS.map((c) => (
              <button key={c} type="button" aria-pressed={c === chain} onClick={() => pickChain(c)} disabled={checking} className={`${c === chain ? btn.primarySm : btn.secondarySm} gap-2`}>
                <ChainLogo chain={c} size={16} />
                {CHAIN_LABELS[c]}
              </button>
            ))}
          </div>
        </div>
        <label htmlFor="pair-token" className={label}>Your token on {CHAIN_LABELS[chain]}</label>
        <div className="flex flex-wrap gap-2">
          <input id="pair-token" value={token} onChange={(e) => setToken(e.target.value)} placeholder="0x…" className={`${input} h-11 min-w-0 flex-1 font-mono text-sm`} autoComplete="off" />
          <button type="button" onClick={() => void runCheck()} disabled={!isAddress(token.trim()) || checking} className={btn.primarySm}>{checking ? "Checking…" : "Check it, free"}</button>
        </div>
        {check ? <PrecheckReport p={check} /> : null}
      </div>
      {check?.ok ? (
        <div className={`${card} space-y-4 p-5`}>
          <div>
            <p className={label}>Price pool</p>
            <div className="space-y-1.5">
              {usable.map((s, i) => (
                <label key={s.pool} className="flex items-start gap-2 text-sm text-body">
                  <input type="radio" name="pair-source" checked={i === source} onChange={() => setSource(i)} className="mt-1" />
                  <span>{s.label}{s.reserve_usd !== null ? ` · $${Math.round(s.reserve_usd).toLocaleString("en-US")} liquidity` : ""}{s.hook ? ` · hook ${s.hook.slice(0, 8)}…` : ""}</span>
                </label>
              ))}
            </div>
            <p className={helper}>Where the site reads your token&apos;s USD price, checked against that pool&apos;s 30-minute average.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="pair-website" className={label}>Website</label>
              <input id="pair-website" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://…" maxLength={200} className={`${input} h-11 text-sm`} />
            </div>
            <div>
              <label htmlFor="pair-x" className={label}>The community&apos;s X account</label>
              <input id="pair-x" value={x} onChange={(e) => setX(e.target.value)} placeholder="handle" maxLength={16} className={`${input} h-11 text-sm`} />
            </div>
          </div>
          <div>
            <label htmlFor="pair-about" className={label}>About · one or two sentences</label>
            <textarea id="pair-about" value={about} onChange={(e) => setAbout(e.target.value)} maxLength={PAIR_DESCRIPTION_MAX} className={`${input} h-auto min-h-20 py-3 text-sm`} />
          </div>
          <div>
            <p className={label}>Logo</p>
            <ImageUpload value={logo} onChange={setLogo} wallet={address} compact />
          </div>
          <p className={helper}>{PAIR_APPLY_COPY.profileNeeded}</p>
          <button type="button" onClick={() => void apply()} disabled={!address || busy || !picked} className={btn.primary}>{!address ? "Connect a wallet to apply" : busy ? "Signing…" : "Sign and apply (nothing is paid yet)"}</button>
        </div>
      ) : null}
      {err ? <p role="alert" className="text-sm text-down-ink">{err}</p> : null}
    </div>
  );
}
