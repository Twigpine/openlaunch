"use client";

import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  buildPrepareLaunchInstruction,
  derivePoolAddresses,
  POOL_ACCOUNT_SPACE,
} from "@openlaunch/solana-sdk";
import { btn, input, label, helper } from "@/components/ui";
import { formatUnits, parseUnits } from "@/lib/solana/config";
import type { SolanaPanelProps } from "./SolanaWorkspace";

export default function LaunchPanel({
  connection,
  config,
  address,
  actions,
}: SolanaPanelProps) {
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [valuation, setValuation] = useState("");
  const [feeBps, setFeeBps] = useState(0);
  const [recipients, setRecipients] = useState("");
  const [uri, setUri] = useState("");
  const [hash, setHash] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [preparing, setPreparing] = useState(false);

  async function prepare() {
    if (
      !address ||
      preparing ||
      !acknowledged ||
      actions.busy ||
      actions.pending ||
      !actions.restored
    )
      return;
    setPreparing(true);
    try {
      const virtualSol = parseUnits(valuation, 9);
      const creator = new PublicKey(address);
      const program = new PublicKey(config.programId);
      const nonce = new DataView(
        crypto.getRandomValues(new Uint8Array(8)).buffer,
      ).getBigUint64(0, true);
      const contentHash = new Uint8Array(32);
      if (hash && !/^[a-fA-F0-9]{64}$/.test(hash))
        throw new Error(
          "The metadata SHA-256 must be exactly 64 hexadecimal characters.",
        );
      if (hash)
        for (let i = 0; i < 32; i++)
          contentHash[i] = parseInt(hash.slice(i * 2, i * 2 + 2), 16);
      if (uri && !/^https:\/\//.test(uri))
        throw new Error("Use an HTTPS metadata URI, or leave it empty.");
      if (Boolean(uri) !== Boolean(hash))
        throw new Error(
          "Supply both the metadata URI and its content hash, or leave both empty.",
        );
      const beneficiaries =
        feeBps === 0
          ? []
          : recipients
              .trim()
              .split(/\r?\n/)
              .filter(Boolean)
              .map((line) => {
                const [wallet, weight, extra] = line.trim().split(/\s+/);
                if (extra || !/^\d+$/.test(weight ?? ""))
                  throw new Error(
                    "Use one recipient per line: wallet-address share-in-basis-points.",
                  );
                return {
                  address: new PublicKey(wallet),
                  weightBps: Number(weight),
                };
              });
      const ix = buildPrepareLaunchInstruction(program, {
        creator,
        nonce,
        virtualSol,
        feeBps,
        name,
        symbol,
        uri,
        contentHash,
        recipients: beneficiaries,
      });
      const addresses = derivePoolAddresses(program, creator, nonce);
      const pool = addresses.pool.toBase58();
      // Pool::SPACE is ABI-v1 fixed maximum allocation, even with shorter text.
      const rent =
        await connection.getMinimumBalanceForRentExemption(POOL_ACCOUNT_SPACE);
      await actions.prepare(
        "Prepare launch",
        [ix],
        [
          ["Name / symbol", `${name} / ${symbol}`],
          ["Token mint", addresses.mint.toBase58()],
          ["Original supply", "1,000,000,000 tokens · 6 decimals"],
          [
            "Initial valuation (not a SOL deposit)",
            `${formatUnits(virtualSol, 9)} SOL`,
          ],
          ["Initial real SOL reserve", "0 SOL"],
          ["Fixed trading fee", `${feeBps / 100}%`],
          ...beneficiaries.map((r, index): [string, string] => [
            `Beneficiary ${index + 1}`,
            `${r.address.toBase58()} · ${r.weightBps / 100}% of trading fees`,
          ]),
          ...(uri
            ? ([
                ["Metadata URI (immutable)", uri],
                ["Metadata SHA-256", hash],
              ] as [string, string][])
            : []),
          [
            "Preparation rent (estimated, permanent)",
            `${formatUnits(BigInt(rent), 9)} SOL`,
          ],
        ],
        pool,
      );
    } catch (e) {
      actions.setError(
        e instanceof Error
          ? e.message
          : "Check the launch terms and try again.",
      );
    } finally {
      setPreparing(false);
    }
  }
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(250px,0.65fr)]">
      <form
        className="min-w-0 space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void prepare();
        }}
      >
        <h2 className="text-xl font-semibold text-ink">Prepare your launch</h2>
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <label>
            <span className={label}>Token name</span>
            <input
              className={input}
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={32}
              placeholder="Token name"
            />
          </label>
          <label>
            <span className={label}>Symbol</span>
            <input
              className={input}
              required
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              maxLength={10}
              placeholder="SYMBOL"
              spellCheck={false}
            />
          </label>
        </div>
        <label className="block">
          <span className={label}>Starting valuation in SOL</span>
          <input
            className={input}
            required
            inputMode="decimal"
            value={valuation}
            onChange={(e) => setValuation(e.target.value)}
            placeholder="Choose the initial pricing offset"
          />
          <span className={`${helper} block leading-relaxed`}>
            1 to 1,000,000 SOL. This changes the curve’s starting price. It does
            not deposit SOL, guarantee a valuation, or create exit liquidity.
          </span>
        </label>
        <fieldset>
          <legend className={label}>Trading fee, fixed forever</legend>
          <div className="flex gap-2">
            {[0, 100, 300].map((fee) => (
              <button
                key={fee}
                type="button"
                className={fee === feeBps ? btn.soft : btn.secondary}
                aria-pressed={fee === feeBps}
                onClick={() => setFeeBps(fee)}
              >
                {fee / 100}%
              </button>
            ))}
          </div>
        </fieldset>
        {feeBps > 0 && (
          <label className="block">
            <span className={label}>Fee recipients</span>
            <textarea
              className={`${input} min-h-28 py-3 font-code text-sm`}
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              required
              placeholder="Wallet address followed by share, e.g. 10000"
            />
            <span className={`${helper} block`}>
              One address and weight per line. 1–7 unique recipients; weights
              must add to 10,000 (100%). Recipients cannot be changed later.
            </span>
            <button
              type="button"
              className="mt-2 text-xs text-brand hover:underline"
              disabled={!address}
              onClick={() => address && setRecipients(`${address} 10000`)}
            >
              Use connected wallet for 100%
            </button>
          </label>
        )}
        <details className="border-y border-line py-4">
          <summary className="cursor-pointer text-sm font-medium text-ink">
            Metadata commitment (optional)
          </summary>
          <div className="mt-4 space-y-4">
            <label className="block">
              <span className={label}>HTTPS metadata URI</span>
              <input
                className={input}
                type="url"
                value={uri}
                onChange={(e) => setUri(e.target.value)}
                maxLength={200}
                placeholder="https://…"
              />
            </label>
            <label className="block">
              <span className={label}>Metadata SHA-256</span>
              <input
                className={`${input} font-code text-xs`}
                value={hash}
                onChange={(e) => setHash(e.target.value)}
                maxLength={64}
                placeholder="64 hexadecimal characters"
                spellCheck={false}
              />
            </label>
            <p className="text-xs leading-relaxed text-muted">
              Stored immutably in the pool, not fetched by the swap program.
              Wallet-readable Metaplex metadata is not included in this review
              build. A content hash does not guarantee hosting availability.
            </p>
          </div>
        </details>
        <label className="flex items-start gap-3 text-sm leading-relaxed text-body">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-1 size-4 accent-[var(--color-brand)]"
            required
          />
          <span>
            I understand that activation is permanent, there is no liquidity
            withdrawal, and the initial real SOL reserve is zero. Preparation
            rent is not refundable.
          </span>
        </label>
        <button
          className={btn.primary}
          disabled={
            !address ||
            !acknowledged ||
            actions.busy ||
            Boolean(actions.pending) ||
            !actions.restored ||
            preparing
          }
        >
          {preparing || actions.busy
            ? "Checking transaction…"
            : "Review preparation"}
        </button>
      </form>
      <aside className="space-y-5 text-sm leading-relaxed text-body">
        <h2 className="text-lg font-semibold text-ink">Two deliberate steps</h2>
        <p>
          Preparation records your immutable terms and reserves a pool address.
          It does not mint tokens or open trading.
        </p>
        <p>
          Activation mints the full supply into the pool and removes mint
          authority in the same transaction. There is no creator allocation and
          no freeze authority.
        </p>
        <p className="border-t border-line pt-5">
          Keep the pool address. You can reopen it with the same wallet to
          activate or cancel a prepared launch. Cancelled addresses cannot be
          reused.
        </p>
      </aside>
    </div>
  );
}
