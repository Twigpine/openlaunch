"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Coins, Layers3, LockKeyhole, RefreshCw, Wallet } from "lucide-react";
import { useAccount, useConfig } from "wagmi";
import { getPublicClient, getWalletClient } from "wagmi/actions";
import type { Address } from "viem";
import TokenAvatar from "./TokenAvatar";
import ChainBadge from "./ChainBadge";
import { QuoteBrandBadge } from "./MuseworldBadge";
import UnlistedPairBadge from "./UnlistedPairBadge";
import FeeChip, { feeModeOf } from "./FeeChip";
import EditTokenSheet from "./EditTokenSheet";
import { toast } from "./TxToasts";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/vendor/tabs";
import { LAUNCH_LOCKER_ABI, ERC20_MIN_ABI } from "@/lib/launchpad/abi";
import { launchpad } from "@/lib/launchpad/config";
import { earnedSides, feeShareBps, feeSidesUsd, hasFees, holdingUsd, isBurnOnly, type FeeSides } from "@/lib/launchpad/creator";
import { fmtCompact, fmtQuote, fmtTokens, fmtUsd } from "@/lib/launchpad/math";
import { capDisplay } from "@/lib/launchpad/market-cap";
import type { LaunchRow, WalletTrade } from "@/lib/launchpad/queries";
import type { EditFields } from "@/lib/launchpad/editAuth";
import { ago } from "@/lib/launchpad/time";
import { BUILDER_DATA_SUFFIX, CHAINS, CHAIN_SHORT, explorerTx, shortAddr, type ChainKey } from "@/lib/chainPublic";
import { friendlyError } from "@/lib/errors";
import { SkRow, SkStat } from "@/components/Skeleton";
import ConnectWallet from "@/components/ConnectWallet";
import styles from "./MeDashboard.module.css";

type Me = { wallet: string; ethUsd: number | null; launches: LaunchRow[]; tokens: (LaunchRow & { my_buys: number; my_sells: number; my_last_trade: string })[]; trades: WalletTrade[] };
type Pending = Record<string, FeeSides | null>; // key chain:token → uncollected fees on both sides (raw), null = unknown
type Balances = Record<string, bigint | null>;

const key = (l: { chain: ChainKey; token: string }) => `${l.chain}:${l.token}`;

/**
 * Creator dashboard. Everything shown is public on-chain data for the connected
 * address; the only writes are transactions the wallet signs (collect / claim)
 * and creator-signed metadata edits. No server keys, no sessions.
 */
export default function MeDashboard() {
  const { address, isConnected } = useAccount();
  // A different account gets a fresh data, balance, and editing boundary.
  return <WalletDashboard key={address?.toLowerCase() ?? "disconnected"} address={address} isConnected={isConnected} />;
}

function WalletDashboard({ address, isConnected }: { address: Address | undefined; isConnected: boolean }) {
  const config = useConfig();
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>({});
  const [balances, setBalances] = useState<Balances>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<LaunchRow | null>(null);
  const [now, setNow] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!address) return;
    setRefreshing(true);
    try {
      const res = await fetch(`/api/me?wallet=${address}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`me ${res.status}`);
      const m = (await res.json()) as Me;
      setMe(m);
      setErr(null);
      setNow(Date.now());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed to load");
    } finally {
      setRefreshing(false);
    }
  }, [address]);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  // Read uncollected fees with eth_call (no gas), then token balances for holdings.
  useEffect(() => {
    if (!me || !address) return;
    let alive = true;
    const run = async () => {
      const p: Pending = {};
      await Promise.all(
        me.launches.map(async (l) => {
          const cfg = launchpad(l.chain);
          if (!cfg.locker || l.lp_fee === 0) {
            p[key(l)] = { quote: 0n, token: 0n };
            return;
          }
          try {
            const pub = getPublicClient(config, { chainId: CHAINS[l.chain].id })!;
            const { result } = await pub.simulateContract({ address: cfg.locker, abi: LAUNCH_LOCKER_ABI, functionName: "collect", args: [BigInt(l.token_id)], account: address });
            p[key(l)] = { quote: result[0], token: result[1] };
          } catch {
            p[key(l)] = null;
          }
        }),
      );
      const b: Balances = {};
      await Promise.all(
        me.tokens.map(async (t) => {
          try {
            const pub = getPublicClient(config, { chainId: CHAINS[t.chain].id })!;
            b[key(t)] = await pub.readContract({ address: t.token as Address, abi: ERC20_MIN_ABI, functionName: "balanceOf", args: [address] });
          } catch {
            b[key(t)] = null;
          }
        }),
      );
      if (alive) {
        setPending(p);
        setBalances(b);
      }
    };
    const id = setTimeout(() => void run(), 0);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [me, address, config]);

  async function collect(l: LaunchRow) {
    const cfg = launchpad(l.chain);
    if (!cfg.locker || !address) return;
    setBusy(key(l));
    try {
      const pub = getPublicClient(config, { chainId: CHAINS[l.chain].id })!;
      const wallet = await getWalletClient(config, { chainId: CHAINS[l.chain].id });
      const { request } = await pub.simulateContract({ address: cfg.locker, abi: LAUNCH_LOCKER_ABI, functionName: "collect", args: [BigInt(l.token_id)], account: address, dataSuffix: BUILDER_DATA_SUFFIX });
      const hash = await wallet.writeContract(request);
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Transaction reverted on-chain.");
      await fetch(`/api/launch/sync?chain=${l.chain}&tx=${hash}`, { method: "POST" }).catch(() => {});
      toast({ kind: "collect", title: `Fees collected for ${l.symbol}`, sub: isBurnOnly(l.recipients) ? "Burned on the spot" : "Paid to the beneficiaries", chain: l.chain, token: l.token, symbol: l.symbol });
      await load();
    } catch (e) {
      toast({ kind: "info", title: `Collect failed for ${l.symbol}`, sub: friendlyError(e) });
    } finally {
      setBusy(null);
    }
  }

  async function collectAll() {
    if (!me) return;
    for (const l of me.launches) {
      if (hasFees(pending[key(l)])) await collect(l);
    }
  }

  if (!isConnected || !address) {
    return (
      <div className={styles.dashboard}>
        <section className={styles.welcome} aria-labelledby="wallet-welcome">
          <div className={styles.welcomeMain}>
            <span className={styles.walletMark} aria-hidden="true"><Wallet size={28} strokeWidth={1.5} /></span>
            <p className={styles.eyebrow}>Start with your wallet</p>
            <h2 id="wallet-welcome">Your wallet.<br /><span>Your workspace.</span></h2>
            <p className={styles.welcomeCopy}>Bring your launches, fees and trading activity into one view. No new account to create.</p>
            <ConnectWallet className={styles.connectButton}>
              Connect wallet<ArrowRight size={16} aria-hidden="true" />
            </ConnectWallet>
            <p className={styles.readOnly}><LockKeyhole size={14} aria-hidden="true" />Connecting lets you read. Transactions and edits need your signature.</p>
          </div>
          <div className={styles.welcomeGuide}>
            <p className={styles.eyebrow}>After you connect</p>
            <ol className={styles.capabilities}>
              <li><span className={styles.step}>01</span><div><h3><Layers3 size={18} aria-hidden="true" />Manage your launches</h3><p>Open each token, update its description, logo and links. On-chain settings stay fixed.</p></div></li>
              <li><span className={styles.step}>02</span><div><h3><Coins size={18} aria-hidden="true" />See where fees go</h3><p>View your beneficiary share and uncollected fees. Collect to the recipients set at launch.</p></div></li>
              <li><span className={styles.step}>03</span><div><h3><ArrowDownLeft size={18} aria-hidden="true" />Follow your activity</h3><p>Check token balances and past trades across every chain, with links to the transactions.</p></div></li>
            </ol>
            <Link href="/#launches" className={styles.browseLink}>Just exploring? Browse launches<ArrowUpRight size={15} aria-hidden="true" /></Link>
          </div>
        </section>
        <div className={styles.disclosure}><span>One wallet. Every chain.</span><p>This dashboard reads public on-chain activity. There is no separate openlaunch account.</p></div>
      </div>
    );
  }

  const collectable = me ? me.launches.filter((l) => hasFees(pending[key(l)])) : [];
  const earnedUsd = me ? me.launches.reduce((a, l) => a + (feeSidesUsd(earnedSides(l, feeShareBps(l.recipients, address)), l.quote_decimals, l.price_quote, l.quote_usd) ?? 0), 0) : 0;
  const holdingsUsd = me ? me.tokens.reduce((a, t) => a + (holdingUsd(balances[key(t)] ?? 0n, t.price_quote, t.quote_usd) ?? 0), 0) : 0;
  const holdingsReading = me?.tokens.some((t) => balances[key(t)] === undefined) ?? false;
  const holdingsUnknown = me?.tokens.some((t) => balances[key(t)] === null || (balances[key(t)] !== undefined && holdingUsd(balances[key(t)]!, t.price_quote, t.quote_usd) === null)) ?? false;
  const feesReading = me?.launches.some((l) => pending[key(l)] === undefined) ?? false;
  const feesUnknown = me?.launches.some((l) => pending[key(l)] === null) ?? false;

  const walletBar = <div className={styles.walletBar}>
    <div className={styles.identity}><span className={styles.walletIcon} aria-hidden="true"><Wallet size={19} /></span><div><p>Connected wallet</p><span className={styles.address} title={address}>{shortAddr(address)}</span></div></div>
    <div className={styles.walletUtilities}><span className={styles.updateNote}>{refreshing ? "Updating your dashboard" : now ? "Latest loaded snapshot" : "Base + Robinhood Chain + Arc"}</span><button type="button" className={styles.refresh} onClick={() => void load()} disabled={refreshing || busy !== null}><RefreshCw size={15} aria-hidden="true" />{refreshing ? "Refreshing…" : "Refresh"}</button></div>
  </div>;

  if (!me) {
    return (
      <div className={styles.dashboard}>
        {walletBar}
        {err ? <div className={styles.error} role="alert"><h2>We couldn’t load your dashboard.</h2><p>{err}. Your wallet and tokens are unchanged.</p><button type="button" className={styles.outlineButton} onClick={() => void load()} disabled={refreshing}>Try again<RefreshCw size={14} aria-hidden="true" /></button></div> : <div className={styles.loading} aria-busy="true" aria-label="Loading your dashboard"><dl className={styles.loadingStats}>{Array.from({ length: 4 }, (_, k) => <SkStat key={k} />)}</dl><ul className={styles.loadingRows}>{Array.from({ length: 3 }, (_, k) => <SkRow key={k} i={k} />)}</ul></div>}
      </div>
    );
  }
  return (
    <div className={styles.dashboard}>
      {walletBar}
      {err ? <p className={styles.error} role="alert">Refresh failed: {err}. Showing the last loaded data. Try Refresh again.</p> : null}
      <dl className={styles.stats}>
        <Stat k="Your launches" v={String(me.launches.length)} hint="Across all chains" />
        <Stat k="Fees earned" v={fmtUsd(earnedUsd, { compact: true })} hint="Your share, USD-priced launches" accent="up" />
        <Stat k="Uncollected" v={feesReading ? "Reading…" : feesUnknown ? "—" : String(collectable.length)} hint={feesUnknown ? "Some pools could not be read" : "Pools with fees to collect"} accent={!feesReading && !feesUnknown && collectable.length ? "warm" : undefined} />
        <Stat k="Holdings value" v={holdingsReading ? "Reading…" : holdingsUnknown ? "—" : fmtUsd(holdingsUsd, { compact: true })} hint={holdingsUnknown ? "A balance or price is unavailable" : "Current estimated USD value"} />
      </dl>

      <Tabs defaultValue="launches" className={styles.ledger}>
        <TabsList aria-label="Your wallet activity" className={styles.tabsList}>
          <TabsTab value="launches">Launches<span className={styles.tabCount}>{me.launches.length}</span></TabsTab>
          <TabsTab value="holdings">Holdings<span className={styles.tabCount}>{me.tokens.length}</span></TabsTab>
          <TabsTab value="trades">Trades<span className={styles.tabCount}>{me.trades.length}</span></TabsTab>
        </TabsList>
      {/* launches */}
      <TabsPanel value="launches">
        <div className={styles.panelHeading}>
          <div><h2>Your launches</h2><p>Manage details and collect trading fees.</p></div>
          {collectable.length > 1 ? (
            <button type="button" onClick={() => void collectAll()} disabled={busy !== null} className={styles.outlineButton}>
              {busy ? "Collecting…" : `Collect all (${collectable.length})`}
            </button>
          ) : null}
        </div>
        {me && me.launches.length === 0 ? (
          <EmptyState icon="launches" title="Your first launch starts here." description="Tokens launched from this wallet will appear here, ready to manage." href="/launch" action="Launch a token" />
        ) : null}
        <ul className={styles.tokenList}>
          {me?.launches.map((l) => {
            const share = feeShareBps(l.recipients, address);
            const earned = earnedSides(l, share);
            const earnedUsdRow = feeSidesUsd(earned, l.quote_decimals, l.price_quote, l.quote_usd);
            const p = pending[key(l)];
            const k = key(l);
            return (
              <li key={k} className={styles.launchRow}>
                  <Link href={`/t/${l.chain}/${l.token}`} className={styles.tokenIdentity}>
                    <TokenAvatar chain={l.chain} token={l.token} symbol={l.symbol} image={l.image_url} size={40} />
                    <div className="min-w-0">
                      <div className={styles.tokenName}>
                        <span className="font-semibold text-[15px] text-ink truncate">{l.name}</span>
                        <span className="font-mono text-xs text-muted">{l.symbol}</span>
                        <ChainBadge chain={l.chain} />
                        <QuoteBrandBadge quoteKey={l.quote_key} />
                        {l.quote_key === "other" ? <UnlistedPairBadge symbol={l.quote_symbol} /> : null}
                      </div>
                      <div className={styles.tokenMeta}>
                        <FeeChip lpFee={l.lp_fee} mode={feeModeOf(l.lp_fee, l.recipients)} />
                        <span>mc {capDisplay(l.fdv_quote, l.quote_usd, { key: l.quote_key, symbol: l.quote_symbol, decimals: l.quote_decimals }).compact}</span>
                        <span>· {l.buys + l.sells} trades</span>
                        {now ? <span suppressHydrationWarning>· {ago(l.block_time, now)} ago</span> : null}
                      </div>
                    </div>
                  </Link>
                  <div className={styles.figure}>
                    <div className="text-up font-bold" title={`${fmtQuote(earned.quote, l.quote_decimals, l.quote_symbol)} + ${fmtTokens(earned.token)} ${l.symbol}`}>{earnedUsdRow !== null ? `${earned.token > 0n ? "≈ " : ""}${fmtUsd(earnedUsdRow)}` : fmtQuote(earned.quote, l.quote_decimals, l.quote_symbol)}</div>
                    {earnedUsdRow === null && earned.token > 0n ? <div className="text-up font-bold">{fmtTokens(earned.token)} {l.symbol}</div> : null}
                    <div className="text-[11px] text-muted">earned · {share / 100}% share</div>
                  </div>
                  <div className={styles.figure}>
                    <div className={hasFees(p) ? "text-warm-ink font-bold" : "text-muted"}>{p === undefined ? "…" : p === null ? "—" : fmtQuote(p.quote, l.quote_decimals, l.quote_symbol)}</div>
                    {p && p.token > 0n ? <div className="text-warm-ink font-bold">{fmtTokens(p.token)} {l.symbol}</div> : null}
                    <div className="text-[11px] text-muted">uncollected</div>
                  </div>
                  <div className={styles.rowActions}>
                    <button type="button" onClick={() => void collect(l)} disabled={busy !== null || !hasFees(p)} className={styles.outlineButton} aria-label={`Collect fees for ${l.symbol}`}>
                      {busy === k ? "Collecting…" : "Collect"}
                    </button>
                    <button type="button" onClick={() => setEditing(l)} className={styles.quietButton} aria-label={`Edit ${l.symbol} details`}>
                      Edit
                    </button>
                  </div>
              </li>
            );
          })}
        </ul>
        <p className={styles.panelNote}><LockKeyhole size={14} aria-hidden="true" />Edits change your description, logo and links. Name, symbol, fee and beneficiaries cannot change.</p>
      </TabsPanel>

      {/* holdings */}
      <TabsPanel value="holdings">
        <div className={styles.panelHeading}><div><h2>Your holdings</h2><p>Current balances for tokens this wallet has traded here.</p></div></div>
        {me.tokens.length === 0 ? <EmptyState icon="holdings" title="Your next discovery belongs here." description="After you trade a token, its balance and estimated value will appear in this view." href="/#launches" action="Explore launches" /> : null}
        <ul className={styles.tokenList}>
          {me?.tokens.map((t) => {
            const bal = balances[key(t)];
            const usd = bal == null ? null : holdingUsd(bal, t.price_quote, t.quote_usd);
            return (
              <li key={key(t)}>
                <Link href={`/t/${t.chain}/${t.token}`} className={styles.holdingRow}>
                  <TokenAvatar chain={t.chain} token={t.token} symbol={t.symbol} image={t.image_url} size={36} />
                  <div className="min-w-0 flex-1">
                    <div className={styles.tokenName}>
                      <span className="font-semibold text-ink truncate">{t.name}</span>
                      <span className="font-mono text-xs text-muted">{t.symbol}</span>
                      <ChainBadge chain={t.chain} />
                      <QuoteBrandBadge quoteKey={t.quote_key} />
                      {t.quote_key === "other" ? <UnlistedPairBadge symbol={t.quote_symbol} /> : null}
                    </div>
                    <div className={styles.tokenMeta}>
                      {t.my_buys} buys · {t.my_sells} sells · mc {capDisplay(t.fdv_quote, t.quote_usd, { key: t.quote_key, symbol: t.quote_symbol, decimals: t.quote_decimals }).compact}
                    </div>
                  </div>
                  <div className={styles.holdingValue}>
                    <div className="text-ink font-bold">{bal === undefined ? "Reading…" : bal === null ? "—" : fmtCompact(Number(bal) / 1e18)}</div>
                    <div className="text-[11px] text-muted">{bal === undefined ? "Reading…" : usd === null ? "USD unavailable" : fmtUsd(usd)}</div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
        <p className={styles.panelNote}>Values are estimates from the latest indexed price, not a guaranteed trade quote. Refresh to read balances again.</p>
      </TabsPanel>

      {/* trades */}
      <TabsPanel value="trades">
        <div className={styles.panelHeading}><div><h2>Your trades</h2><p>The latest indexed buys and sells from this wallet.</p></div></div>
        {me.trades.length === 0 ? <EmptyState icon="trades" title="A clean trading history." description="Your buys and sells will be listed here, with a transaction link for every trade." href="/#launches" action="Explore launches" /> : null}
        {me && me.trades.length > 0 ? (
          <div className={`${styles.tradeScroll} bb-scroll`} role="region" aria-label="Your trades table" tabIndex={0}>
            <table className={styles.trades}>
              <caption className="sr-only">Your latest indexed trades on Base, Robinhood Chain and Arc</caption>
              <thead><tr><th scope="col">Side</th><th scope="col">Token / chain</th><th scope="col">Amount</th><th scope="col" className={styles.usdColumn}>USD value</th><th scope="col">Transaction</th></tr></thead>
              <tbody className="font-mono tnum">
                {me.trades.map((t) => (
                  <tr key={t.tx_hash} className="border-b border-line last:border-0">
                    <td><span className={`${styles.tradeSide} ${t.is_buy ? "text-up" : "text-down-ink"}`}>{t.is_buy ? <ArrowDownLeft size={14} aria-hidden="true" /> : <ArrowUpRight size={14} aria-hidden="true" />}{t.is_buy ? "Buy" : "Sell"}</span></td>
                    <td><Link href={`/t/${t.chain}/${t.token}`}>{t.symbol}</Link> <span className={styles.tradeChain}>{CHAIN_SHORT[t.chain]}</span></td>
                    <td>{fmtQuote(t.quote_raw, t.quote_decimals, t.quote_symbol)}</td>
                    <td className={styles.usdColumn}>{t.usd !== null ? fmtUsd(t.usd) : "—"}</td>
                    <td>
                      <a href={explorerTx(t.chain, t.tx_hash)} target="_blank" rel="noreferrer" className={styles.txLink} aria-label={`View ${t.symbol} ${t.is_buy ? "buy" : "sell"} transaction on explorer`} suppressHydrationWarning>{now ? ago(t.block_time, now) : "View"}<ArrowUpRight size={13} aria-hidden="true" /></a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </TabsPanel>
      </Tabs>

      <div className={styles.disclosure}><span>Public activity. Your signature.</span><p>Viewing is read-only. Collecting fees asks for a transaction; editing details asks for a signature.</p></div>

      {editing ? (
        <EditTokenSheet
          chain={editing.chain}
          token={editing.token}
          symbol={editing.symbol}
          initial={{ description: editing.description ?? "", image_url: editing.image_url ?? "", website: editing.website ?? "", x_handle: editing.x_handle ?? "" }}
          onClose={() => setEditing(null)}
          onSaved={(f: EditFields) => {
            setMe((m) => (m ? { ...m, launches: m.launches.map((l) => (key(l) === key(editing) ? { ...l, description: f.description || null, image_url: f.image_url || null, website: f.website || null, x_handle: f.x_handle || null } : l)) } : m));
            toast({ kind: "info", title: `${editing.symbol} details updated` });
          }}
        />
      ) : null}
    </div>
  );
}

function Stat({ k, v, hint, accent }: { k: string; v: string; hint: string; accent?: "up" | "warm" }) {
  return (
    <div className={styles.stat}>
      <dt>{k}</dt>
      <dd className={accent === "up" ? "text-up" : accent === "warm" ? "text-warm-ink" : "text-ink"}>{v}</dd>
      <dd className={styles.statHint}>{hint}</dd>
    </div>
  );
}

function EmptyState({ icon, title, description, href, action }: { icon: "launches" | "holdings" | "trades"; title: string; description: string; href: string; action: string }) {
  const Icon = icon === "launches" ? Layers3 : icon === "holdings" ? Wallet : ArrowDownLeft;
  return <div className={styles.empty}><span className={styles.emptyIcon} aria-hidden="true"><Icon size={24} strokeWidth={1.5} /></span><h3>{title}</h3><p>{description}</p><Link href={href} className={styles.outlineButton}>{action}<ArrowRight size={15} aria-hidden="true" /></Link></div>;
}
