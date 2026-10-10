"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  Wallet,
} from "lucide-react";
import {
  fetchActivePools,
  fetchPoolSnapshot,
  verifyImmutableProgram,
  type PoolSnapshot,
} from "@openlaunch/solana-sdk";
import { btn, input, label as labelClass } from "@/components/ui";
import {
  explorerUrl,
  formatUnits,
  publicKey,
  type SolanaConfig,
} from "@/lib/solana/config";
import { useSolanaWallet } from "@/lib/solana/wallet";
import { useSolanaAction } from "@/lib/solana/useSolanaAction";
import LaunchPanel from "./LaunchPanel";
import PoolPanel from "./PoolPanel";

export type ActionController = ReturnType<typeof useSolanaAction>;
export type SolanaPanelProps = {
  connection: Connection;
  config: SolanaConfig;
  address: string | null;
  actions: ActionController;
  onPool: (address: string) => void;
};
const short = (key: string) => `${key.slice(0, 5)}…${key.slice(-5)}`;

export default function SolanaWorkspace({
  config,
  initialPool,
}: {
  config: SolanaConfig;
  initialPool?: string;
}) {
  const [connection] = useState(
    () =>
      new Connection(
        typeof window === "undefined"
          ? "http://localhost/api/solana/rpc"
          : new URL(config.rpcPath, window.location.origin).href,
        {
          commitment: "confirmed",
          disableRetryOnRateLimit: true,
          fetch: (url, init) =>
            fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }),
        },
      ),
  );
  const programId = useMemo(
    () => new PublicKey(config.programId),
    [config.programId],
  );
  const wallet = useSolanaWallet(config.cluster);
  const [lookup, setLookup] = useState(initialPool ?? "");
  const [poolAddress, setPoolAddress] = useState(initialPool ?? "");
  const [snapshot, setSnapshot] = useState<PoolSnapshot | null>(null);
  const [list, setList] = useState<
    { key: string; name: string; symbol: string }[]
  >([]);
  const [listTotal, setListTotal] = useState(0);
  const [failure, setFailure] = useState("");
  const [verified, setVerified] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [view, setView] = useState<"explore" | "launch">("explore");
  const reload = useCallback(() => setRefresh((n) => n + 1), []);
  const settle = useCallback((pool: string | null) => {
    if (pool) {
      setPoolAddress(pool);
      setLookup(pool);
      setView("explore");
    }
    setRefresh((n) => n + 1);
  }, []);
  const actions = useSolanaAction(
    config,
    connection,
    wallet.session,
    wallet.sign,
    settle,
    `${poolAddress}:${view}:${refresh}`,
  );
  const address = wallet.session?.account.address ?? null;
  const openPool = useCallback((key: string) => {
    setPoolAddress(key);
    setLookup(key);
    setView("explore");
  }, []);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      setLoading(true);
      setFailure("");
      setSnapshot(null);
      setVerified(false);
      try {
        await verifyImmutableProgram(connection, programId);
        if (!alive) return;
        setVerified(true);
        if (poolAddress) {
          const result = await fetchPoolSnapshot(
            connection,
            programId,
            new PublicKey(poolAddress),
          );
          if (alive) setSnapshot(result);
        } else {
          // Active pools only, addresses first: tombstoned pools never travel, so the list cannot outgrow the proxy.
          const { total, pools } = await fetchActivePools(
            connection,
            programId,
            50,
          );
          if (alive) {
            setList(
              pools.map(({ address, pool }) => ({
                key: address.toBase58(),
                name: pool.name,
                symbol: pool.symbol,
              })),
            );
            setListTotal(total);
          }
        }
      } catch (e) {
        if (alive)
          setFailure(
            e instanceof Error
              ? e.message
              : "Could not read Solana state. Try again.",
          );
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [connection, programId, poolAddress, refresh]);
  const props: SolanaPanelProps = {
    connection,
    config,
    address,
    actions,
    onPool: openPool,
  };
  const locked = actions.busy || Boolean(actions.pending) || !actions.restored;
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-sm text-muted hover:text-ink"
      >
        <ArrowLeft size={15} aria-hidden />
        Launchpad
      </Link>
      <header className="mt-6 flex flex-wrap items-start justify-between gap-5 border-b border-line pb-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-ink">
            Solana workspace
          </h1>
          <p className="mt-2 text-sm text-body">
            {config.cluster === "devnet"
              ? "Devnet review. Test SOL only. Not a production release."
              : "Native SOL pools. Fixed terms, no admin controls."}
          </p>
        </div>
        <div className="text-sm text-body">
          {verified ? (
            <span className="inline-flex items-center gap-2">
              <Check size={15} className="text-up" aria-hidden />
              Upgrade authority removed
            </span>
          ) : (
            <span>Checking deployment</span>
          )}
          <a
            className="mt-1 flex items-center justify-end gap-1 text-xs text-muted hover:text-ink"
            href={explorerUrl(config.cluster, "address", config.programId)}
            target="_blank"
            rel="noreferrer"
          >
            {short(config.programId)}
            <ArrowUpRight size={12} aria-hidden />
          </a>
        </div>
      </header>

      <section
        className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-4"
        aria-label="Solana wallet"
      >
        {address ? (
          <>
            <div className="flex items-center gap-2 text-sm text-ink">
              <Wallet size={16} aria-hidden />
              <span className="font-code">{short(address)}</span>
              <span className="text-muted">{wallet.session?.wallet.name}</span>
            </div>
            <button
              type="button"
              className={btn.secondarySm}
              disabled={actions.busy}
              onClick={() =>
                void wallet
                  .disconnect()
                  .catch(() => actions.setError("Wallet disconnected locally."))
              }
            >
              Disconnect
            </button>
          </>
        ) : (
          <>
            <span className="text-sm text-body">
              Connect a Solana wallet to launch or trade.
            </span>
            <div className="flex flex-wrap gap-2">
              {wallet.wallets.map((w, i) => (
                <button
                  key={`${w.name}:${i}`}
                  className={btn.secondarySm}
                  type="button"
                  onClick={() =>
                    void wallet
                      .connect(w)
                      .catch((e: unknown) =>
                        actions.setError(
                          e instanceof Error
                            ? e.message
                            : "Wallet connection failed.",
                        ),
                      )
                  }
                >
                  {w.name}
                </button>
              ))}
              {wallet.wallets.length === 0 && (
                <span className="max-w-xs text-xs leading-relaxed text-muted">
                  No compatible wallet detected. Open in a Wallet
                  Standard-enabled browser or wallet.
                </span>
              )}
            </div>
          </>
        )}
      </section>

      {actions.pending && (
        <section
          aria-live="polite"
          className="mt-6 rounded-2xl border border-line-strong bg-card p-5"
        >
          <h2 className="text-base font-semibold text-ink">
            {actions.pending.label}: waiting for finality
          </h2>
          <p className="mt-2 text-sm text-body">
            {actions.message ||
              "Checking the signed transaction. Do not submit a replacement."}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <a
              className={btn.secondarySm}
              href={explorerUrl(
                config.cluster,
                "tx",
                actions.pending.signature,
              )}
              target="_blank"
              rel="noreferrer"
            >
              View transaction
              <ArrowUpRight size={14} aria-hidden />
            </a>
            <button
              className={btn.secondarySm}
              onClick={() => void actions.check()}
            >
              Check status
            </button>
            {actions.pending.pool && (
              <button
                className={btn.secondarySm}
                onClick={() => openPool(actions.pending!.pool!)}
              >
                Open pool
              </button>
            )}
          </div>
          <p className="mt-3 text-xs text-muted">
            This record stays in this browser across reloads. Do not clear site
            storage while confirmation is unresolved.
          </p>
        </section>
      )}
      {!actions.pending && actions.message && (
        <p className="mt-5 text-sm text-body" role="status">
          {actions.message}
        </p>
      )}
      {(failure || actions.error) && (
        <div
          role="alert"
          className="mt-6 flex items-start gap-3 rounded-xl border border-down/25 bg-down-soft p-4 text-sm text-down-ink"
        >
          <ShieldAlert size={18} className="mt-0.5 shrink-0" aria-hidden />
          <div className="min-w-0 break-words">
            <p>{failure || actions.error}</p>
            <p className="mt-1 text-xs">
              No new transaction is sent automatically. If you already signed,
              check its status first.
            </p>
          </div>
        </div>
      )}

      {actions.review ? (
        <section
          className="my-6 max-w-xl rounded-2xl border border-line-strong bg-card p-5 sm:p-6"
          aria-labelledby="review-heading"
        >
          <h2 id="review-heading" className="text-xl font-semibold text-ink">
            Review {actions.review.label.toLowerCase()}
          </h2>
          <dl className="my-5 divide-y divide-line">
            {[
              ["Wallet", address ?? "Disconnected"],
              ["Network", config.cluster],
              ["Program", config.programId],
              ...(actions.review.pool
                ? [["Pool address", actions.review.pool]]
                : []),
              ...actions.review.lines,
              [
                "Network fee (estimated)",
                `${formatUnits(BigInt(actions.review.networkFee), 9)} SOL`,
              ],
            ].map(([term, value]) => (
              <div
                key={term}
                className="flex justify-between gap-6 py-3 text-sm"
              >
                <dt className="min-w-0 break-words text-muted">{term}</dt>
                <dd className="max-w-[65%] break-all text-right font-medium text-ink">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mb-5 text-xs leading-relaxed text-muted">
            Simulation passed. Review the same instructions in your wallet. Pool
            creation and token-account rent are additional where listed. This
            transaction can expire; expiry requires a new review, never an
            automatic retry.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              className={btn.primary}
              disabled={locked}
              onClick={() => void actions.confirm()}
            >
              {actions.busy ? (
                <LoaderCircle
                  size={16}
                  className="animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
              ) : null}
              Confirm in wallet
            </button>
            <button
              className={btn.secondary}
              disabled={actions.busy}
              onClick={actions.cancelReview}
            >
              Back
            </button>
          </div>
        </section>
      ) : (
        <>
          <div className="my-6 flex flex-wrap justify-between gap-3">
            <div className="flex gap-2" aria-label="Workspace view">
              <button
                className={view === "explore" ? btn.softSm : btn.secondarySm}
                aria-pressed={view === "explore"}
                onClick={() => setView("explore")}
              >
                Pools
              </button>
              <button
                className={view === "launch" ? btn.softSm : btn.secondarySm}
                aria-pressed={view === "launch"}
                onClick={() => setView("launch")}
                disabled={!verified}
              >
                Launch a token
              </button>
            </div>
            <button
              aria-label="Refresh Solana state"
              className={btn.secondarySm}
              disabled={loading || actions.busy}
              onClick={reload}
            >
              <RefreshCw size={14} aria-hidden />
              Refresh
            </button>
          </div>
          {view === "launch" ? (
            <LaunchPanel {...props} />
          ) : (
            <>
              <form
                className="mb-6 flex items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (publicKey(lookup)) openPool(lookup);
                  else
                    actions.setError(
                      "Enter the complete, case-sensitive pool address.",
                    );
                }}
              >
                <label className="min-w-0 flex-1">
                  <span className={labelClass}>Find a pool</span>
                  <input
                    className={input}
                    value={lookup}
                    onChange={(e) => setLookup(e.target.value)}
                    placeholder="Solana pool address"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <button className={btn.secondary} disabled={loading}>
                  Open
                </button>
              </form>
              {poolAddress && (
                <button
                  className="mb-4 text-sm text-muted hover:text-ink"
                  onClick={() => {
                    setPoolAddress("");
                    setLookup("");
                  }}
                >
                  Back to pool list
                </button>
              )}
              {loading ? (
                <p role="status" className="py-12 text-sm text-muted">
                  Reading program and pool accounts…
                </p>
              ) : snapshot ? (
                <PoolPanel {...props} snapshot={snapshot} onRefresh={reload} />
              ) : !poolAddress && !failure ? (
                <section aria-label="Active pools">
                  <div className="flex justify-between border-b border-line py-3 text-xs text-muted">
                    <span>Active pools</span>
                    <span>
                      {list.length} shown
                      {listTotal > list.length ? ` of ${listTotal}` : ""}
                    </span>
                  </div>
                  {list.length ? (
                    <ul className="divide-y divide-line">
                      {list.map((pool) => (
                        <li key={pool.key}>
                          <Link
                            href={`/solana/pool/${pool.key}`}
                            className="flex items-center justify-between gap-4 py-5 text-sm hover:text-brand"
                          >
                            <span className="min-w-0">
                              <strong className="block truncate text-base">
                                {pool.name}
                              </strong>
                              <span className="text-muted">
                                {pool.symbol} · SOL pair
                              </span>
                            </span>
                            <ArrowUpRight
                              size={18}
                              className="shrink-0"
                              aria-hidden
                            />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="py-10 text-sm text-muted">
                      No active pools on this program yet. Prepare and activate
                      a launch to start a market.
                    </p>
                  )}
                </section>
              ) : null}
            </>
          )}
        </>
      )}
      <footer className="mt-12 border-t border-line pt-5 text-xs leading-relaxed text-muted">
        No Openlaunch fee. Trading fees, if selected, go only to the pool’s
        fixed beneficiaries. Locked liquidity does not guarantee profit or a
        sale price. The virtual offset is not SOL in custody. This review
        workspace has no aggregator listing, price-oracle, or cross-chain bridge
        dependency.
      </footer>
    </main>
  );
}
