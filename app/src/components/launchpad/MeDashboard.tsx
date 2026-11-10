"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Coins, Flame, Hourglass, Layers3, LockKeyhole, PencilLine, RefreshCw, Wallet } from "lucide-react";
import { useConfig } from "wagmi";
import { useTranslations } from "use-intl";
import { useHydratedAccount } from "@/lib/useHydratedAccount";
import { getPublicClient, getWalletClient } from "wagmi/actions";
import type { Address } from "viem";
import TokenAvatar from "./TokenAvatar";
import { ChainCorner, ChainLogoStack } from "./ChainLogo";
import { QuoteBrandBadge } from "./QuoteBadge";
import UnlistedPairBadge from "./UnlistedPairBadge";
import FeeChip, { feeModeOf } from "./FeeChip";
import EditTokenSheet from "./EditTokenSheet";
import { toast } from "./TxToasts";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/vendor/tabs";
import { LAUNCH_LOCKER_ABI, ERC20_MIN_ABI } from "@/lib/launchpad/abi";
import { VISIBLE_CHAINS, launchpad } from "@/lib/launchpad/config";
import { earnedSides, feeShareBps, feeSidesUsd, hasFees, holdingUsd, holdingsValue, isBurnOnly, type FeeSides } from "@/lib/launchpad/creator";
import { fmtCompact, fmtQuote, fmtTokens, fmtUsd } from "@/lib/launchpad/math";
import { capDisplay } from "@/lib/launchpad/market-cap";
import type { LaunchRow, WalletTrade } from "@/lib/launchpad/queries";
import type { EditFields } from "@/lib/launchpad/editAuth";
import { BUILDER_DATA_SUFFIX, CHAINS, CHAIN_SHORT, explorerTx, type ChainKey } from "@/lib/chainPublic";
import { friendlyError } from "@/lib/errors";
import { useAgo } from "@/i18n/useAgo";
import { clientTranslator } from "@/i18n/client";
import { SkRow, SkStat } from "@/components/Skeleton";
import ConnectWallet from "@/components/ConnectWallet";
import ProfileIdentity from "@/components/profile/ProfileIdentity";
import SeasonCard from "@/components/points/SeasonCard";
import EarnCard from "@/components/earn/EarnCard";
import { useBoostOn } from "./useBoostOn";
import { BOOST_CHAIN } from "@/lib/launchpad/boost";
import styles from "./MeDashboard.module.css";

type Me = { wallet: string; ethUsd: number | null; launches: LaunchRow[]; tokens: (LaunchRow & { my_buys: number; my_sells: number; my_last_trade: string })[]; trades: WalletTrade[] };
type Pending = Record<string, FeeSides | null>; // key chain:token → uncollected fees on both sides (raw), null = unknown
type Balances = Record<string, bigint | null>;

/** A launch's key in the balances map (chain and token). */
const key = (l: { chain: ChainKey; token: string }) => `${l.chain}:${l.token}`;

/**
 * Creator dashboard. Everything shown is public on-chain data for the connected
 * address; the only writes are transactions the wallet signs (collect / claim)
 * and creator-signed metadata edits. No server keys, no sessions.
 */
export default function MeDashboard() {
  const { address, isConnected } = useHydratedAccount();
  // A different account gets a fresh data, balance, and editing boundary.
  return <WalletDashboard key={address?.toLowerCase() ?? "disconnected"} address={address} isConnected={isConnected} />;
}

/** The dashboard for one connected wallet: its profile card, figures, launches, holdings and trades. */
function WalletDashboard({ address, isConnected }: { address: Address | undefined; isConnected: boolean }) {
  const config = useConfig();
  const boostOn = useBoostOn();
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>({});
  const [balances, setBalances] = useState<Balances>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<LaunchRow | null>(null);
  const [now, setNow] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  // `t` is the token in the lists below, so the dashboard's words are `tr`
  const tr = useTranslations("account.dashboard");
  const tc = useTranslations("common");
  const { short, ago } = useAgo();

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
      setErr(e instanceof Error ? e.message : clientTranslator("account")("dashboard.loadFailed"));
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
      if (receipt.status !== "success") throw new Error(tr("toasts.reverted"));
      await fetch(`/api/launch/sync?chain=${l.chain}&tx=${hash}`, { method: "POST" }).catch(() => {});
      toast({ kind: "collect", title: tr("toasts.collected", { symbol: l.symbol }), sub: isBurnOnly(l.recipients) ? tr("toasts.burned") : tr("toasts.paid"), chain: l.chain, token: l.token, symbol: l.symbol });
      await load();
    } catch (e) {
      toast({ kind: "info", title: tr("toasts.collectFailed", { symbol: l.symbol }), sub: friendlyError(e) });
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
            <span className={styles.walletMark} aria-hidden="true"><Wallet size={22} strokeWidth={1.75} /></span>
            <p className={styles.eyebrow}>{tr("welcome.eyebrow")}</p>
            <h2 id="wallet-welcome">{tr("welcome.titleTop")}<br /><span>{tr("welcome.titleBottom")}</span></h2>
            <p className={styles.welcomeCopy}>{tr("welcome.copy")}</p>
            <ConnectWallet className={styles.connectButton}>
              <span className={styles.buttonTile} aria-hidden="true"><Wallet size={17} /></span>
              {tc("connectWallet")}<ArrowRight size={16} aria-hidden="true" />
            </ConnectWallet>
            <p className={styles.readOnly}><LockKeyhole size={14} aria-hidden="true" />{tr("welcome.readOnly")}</p>
          </div>
          <div className={styles.welcomeGuide}>
            <p className={styles.eyebrow}>{tr("welcome.after")}</p>
            <ol className={styles.capabilities}>
              <li><span className={styles.capIcon} aria-hidden="true"><Layers3 size={17} /></span><div><h3>{tr("welcome.manageTitle")}</h3><p>{tr("welcome.manageCopy")}</p></div></li>
              <li><span className={styles.capIcon} aria-hidden="true"><Coins size={17} /></span><div><h3>{tr("welcome.feesTitle")}</h3><p>{tr("welcome.feesCopy")}</p></div></li>
              <li><span className={styles.capIcon} aria-hidden="true"><ArrowDownLeft size={17} /></span><div><h3>{tr("welcome.activityTitle")}</h3><p>{tr("welcome.activityCopy")}</p></div></li>
            </ol>
            <Link href="/#launches" className={styles.browseLink}>{tr("welcome.browse")}<ArrowUpRight size={15} aria-hidden="true" /></Link>
          </div>
        </section>
        <div className={styles.disclosure}><span>{tr("welcome.disclosureTitle")}</span><p>{tr("welcome.disclosure")}</p></div>
      </div>
    );
  }

  const collectable = me ? me.launches.filter((l) => hasFees(pending[key(l)])) : [];
  const earnedUsd = me ? me.launches.reduce((a, l) => a + (feeSidesUsd(earnedSides(l, feeShareBps(l.recipients, address)), l.quote_decimals, l.price_quote, l.quote_usd) ?? 0), 0) : 0;
  // a token paired with a quote nothing prices (an unlisted pair, a stock without a feed) is left out of the total, not allowed to blank it
  const holdings = holdingsValue((me?.tokens ?? []).map((t) => ({ balance: balances[key(t)], priceQuote: t.price_quote, quoteUsd: t.quote_usd, priced: t.quote_priced })));
  const feesReading = me?.launches.some((l) => pending[key(l)] === undefined) ?? false;
  const feesUnknown = me?.launches.some((l) => pending[key(l)] === null) ?? false;

  const walletBar = <div className={styles.walletBar}>
    <div className={styles.identity}><ProfileIdentity address={address} avatarClass={styles.walletIcon} labelClass={styles.identityLabel} addressClass={styles.address} /></div>
    <div className={styles.walletUtilities}><span className={styles.updateNote}><ChainLogoStack chains={VISIBLE_CHAINS} size={16} />{refreshing ? tr("updating") : now ? tr("snapshot") : "Base + Robinhood Chain + Arc"}</span><button type="button" className={styles.refresh} onClick={() => void load()} disabled={refreshing || busy !== null}><RefreshCw size={15} aria-hidden="true" />{refreshing ? tr("refreshing") : tr("refresh")}</button></div>
  </div>;

  if (!me) {
    // the season card sits in the same place in every state (points come from their own endpoint, so they show even
    // when the dashboard could not load), and React keeps the same card as the dashboard arrives
    return (
      <div className={styles.dashboard}>
        {walletBar}
        <SeasonCard address={address} />
        <EarnCard address={address} />
        {err ? <div className={styles.error} role="alert"><h2>{tr("loadError")}</h2><p>{tr("loadErrorDetail", { error: err })}</p><button type="button" className={styles.outlineButton} onClick={() => void load()} disabled={refreshing}>{tr("tryAgain")}<RefreshCw size={14} aria-hidden="true" /></button></div> : <div className={styles.loading} aria-busy="true" aria-label={tr("loading")}><dl className={styles.loadingStats}>{Array.from({ length: 4 }, (_, k) => <SkStat key={k} />)}</dl><ul className={styles.loadingRows}>{Array.from({ length: 3 }, (_, k) => <SkRow key={k} i={k} />)}</ul></div>}
      </div>
    );
  }
  return (
    <div className={styles.dashboard}>
      {walletBar}
      <SeasonCard address={address} />
      <EarnCard address={address} />
      {err ? <p className={styles.error} role="alert">{tr("refreshFailed", { error: err })}</p> : null}
      <dl className={styles.stats}>
        <Stat k={tr("stats.launches")} icon={<Layers3 size={14} />} v={String(me.launches.length)} hint={tr("stats.launchesHint")} />
        <Stat k={tr("stats.earned")} icon={<Coins size={14} />} v={fmtUsd(earnedUsd, { compact: true })} hint={tr("stats.earnedHint")} accent="up" />
        <Stat k={tr("stats.uncollected")} icon={<Hourglass size={14} />} v={feesReading ? tr("reading") : feesUnknown ? "—" : String(collectable.length)} hint={feesUnknown ? tr("stats.uncollectedUnknown") : tr("stats.uncollectedHint")} accent={!feesReading && !feesUnknown && collectable.length ? "warm" : undefined} />
        <Stat k={tr("stats.holdings")} icon={<Wallet size={14} />} v={holdings.reading ? tr("reading") : holdings.unknown ? "—" : fmtUsd(holdings.usd, { compact: true })} hint={holdings.unknown ? tr("stats.holdingsUnknown") : holdings.unpriced ? tr("stats.holdingsUnpriced", { count: holdings.unpriced }) : tr("stats.holdingsHint")} />
      </dl>

      <Tabs defaultValue="launches" className={styles.ledger}>
        <TabsList aria-label={tr("tabs.label")} className={styles.tabsList}>
          <TabsTab value="launches">{tr("tabs.launches")}<span className={styles.tabCount}>{me.launches.length}</span></TabsTab>
          <TabsTab value="holdings">{tr("tabs.holdings")}<span className={styles.tabCount}>{me.tokens.length}</span></TabsTab>
          <TabsTab value="trades">{tr("tabs.trades")}<span className={styles.tabCount}>{me.trades.length}</span></TabsTab>
        </TabsList>
      {/* launches */}
      <TabsPanel value="launches">
        <div className={styles.panelHeading}>
          <div><h2>{tr("launches.title")}</h2><p>{tr("launches.description")}</p></div>
          {collectable.length > 1 ? (
            <button type="button" onClick={() => void collectAll()} disabled={busy !== null} className={styles.collectButton}>
              <Coins size={15} aria-hidden="true" />{busy ? tr("launches.collecting") : tr("launches.collectAll", { count: collectable.length })}
            </button>
          ) : null}
        </div>
        {me && me.launches.length === 0 ? (
          <EmptyState icon="launches" title={tr("launches.emptyTitle")} description={tr("launches.emptyDescription")} href="/launch" action={tc("launchToken")} />
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
                    <span className={styles.avatar}><TokenAvatar chain={l.chain} token={l.token} symbol={l.symbol} image={l.image_url} size={40} className="rounded-xl" /><ChainCorner chain={l.chain} /></span>
                    <div className="min-w-0">
                      <div className={styles.tokenName}>
                        <span className="font-semibold text-[15px] text-ink truncate">{l.name}</span>
                        <span className="font-mono text-xs text-muted">{l.symbol}</span>
                        <QuoteBrandBadge quoteKey={l.quote_key} symbol={l.quote_symbol} logo={l.quote_logo} />
                        {l.quote_key === "other" ? <UnlistedPairBadge symbol={l.quote_symbol} /> : null}
                      </div>
                      <div className={styles.tokenMeta}>
                        <FeeChip lpFee={l.lp_fee} mode={feeModeOf(l.lp_fee, l.recipients)} />
                        <span>{CHAIN_SHORT[l.chain]}</span>
                        <span>· {tr("launches.marketCap", { cap: capDisplay(l.fdv_quote, l.quote_usd, { key: l.quote_key, symbol: l.quote_symbol, decimals: l.quote_decimals }).compact })}</span>
                        <span>· {tr("launches.trades", { count: l.buys + l.sells })}</span>
                        {now ? <span suppressHydrationWarning>· {ago(l.block_time, now)}</span> : null}
                      </div>
                    </div>
                  </Link>
                  <div className={styles.figure}>
                    <div className="text-up font-bold" title={`${fmtQuote(earned.quote, l.quote_decimals, l.quote_symbol)} + ${fmtTokens(earned.token)} ${l.symbol}`}>{earnedUsdRow !== null ? `${earned.token > 0n ? "≈ " : ""}${fmtUsd(earnedUsdRow)}` : fmtQuote(earned.quote, l.quote_decimals, l.quote_symbol)}</div>
                    {earnedUsdRow === null && earned.token > 0n ? <div className="text-up font-bold">{fmtTokens(earned.token)} {l.symbol}</div> : null}
                    <div className="text-[11px] text-muted">{tr("launches.earned", { share: share / 100 })}</div>
                  </div>
                  <div className={styles.figure}>
                    <div className={hasFees(p) ? "text-warm-ink font-bold" : "text-muted"}>{p === undefined ? "…" : p === null ? "—" : fmtQuote(p.quote, l.quote_decimals, l.quote_symbol)}</div>
                    {p && p.token > 0n ? <div className="text-warm-ink font-bold">{fmtTokens(p.token)} {l.symbol}</div> : null}
                    <div className="text-[11px] text-muted">{tr("launches.uncollected")}</div>
                  </div>
                  <div className={styles.rowActions}>
                    <button type="button" onClick={() => void collect(l)} disabled={busy !== null || !hasFees(p)} className={styles.collectButton} aria-label={tr("launches.collectFor", { symbol: l.symbol })}>
                      <Coins size={14} aria-hidden="true" />{busy === k ? tr("launches.collecting") : tr("launches.collect")}
                    </button>
                    <button type="button" onClick={() => setEditing(l)} className={styles.quietButton} aria-label={tr("launches.editFor", { symbol: l.symbol })}>
                      <PencilLine size={14} aria-hidden="true" />{tr("launches.edit")}
                    </button>
                    {/* Boost opens the dialog on the token's page (Base only, while the switch is on) */}
                    {boostOn && l.chain === BOOST_CHAIN ? (
                      <Link href={`/t/${l.chain}/${l.token}?boost=1#boost`} className={styles.quietButton} aria-label={`Boost ${l.symbol} with TWIG`}>
                        <Flame size={14} aria-hidden="true" />Boost
                      </Link>
                    ) : null}
                  </div>
              </li>
            );
          })}
        </ul>
        <p className={styles.panelNote}><LockKeyhole size={14} aria-hidden="true" />{tr("launches.note")}</p>
      </TabsPanel>

      {/* holdings */}
      <TabsPanel value="holdings">
        <div className={styles.panelHeading}><div><h2>{tr("holdings.title")}</h2><p>{tr("holdings.description")}</p></div></div>
        {me.tokens.length === 0 ? <EmptyState icon="holdings" title={tr("holdings.emptyTitle")} description={tr("holdings.emptyDescription")} href="/#launches" action={tr("explore")} /> : null}
        <ul className={styles.tokenList}>
          {me?.tokens.map((t) => {
            const bal = balances[key(t)];
            const usd = bal == null ? null : holdingUsd(bal, t.price_quote, t.quote_usd);
            return (
              <li key={key(t)}>
                <Link href={`/t/${t.chain}/${t.token}`} className={styles.holdingRow}>
                  <span className={styles.avatar}><TokenAvatar chain={t.chain} token={t.token} symbol={t.symbol} image={t.image_url} size={36} className="rounded-xl" /><ChainCorner chain={t.chain} /></span>
                  <div className="min-w-0 flex-1">
                    <div className={styles.tokenName}>
                      <span className="font-semibold text-ink truncate">{t.name}</span>
                      <span className="font-mono text-xs text-muted">{t.symbol}</span>
                      <QuoteBrandBadge quoteKey={t.quote_key} symbol={t.quote_symbol} logo={t.quote_logo} />
                      {t.quote_key === "other" ? <UnlistedPairBadge symbol={t.quote_symbol} /> : null}
                    </div>
                    <div className={styles.tokenMeta}>
                      {tr("holdings.meta", { chain: CHAIN_SHORT[t.chain], buys: t.my_buys, sells: t.my_sells, cap: capDisplay(t.fdv_quote, t.quote_usd, { key: t.quote_key, symbol: t.quote_symbol, decimals: t.quote_decimals }).compact })}
                    </div>
                  </div>
                  <div className={styles.holdingValue}>
                    <div className="text-ink font-bold">{bal === undefined ? tr("reading") : bal === null ? "—" : fmtCompact(Number(bal) / 1e18)}</div>
                    <div className="text-[11px] text-muted">{bal === undefined ? tr("reading") : usd === null ? tr("holdings.usdUnavailable") : fmtUsd(usd)}</div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
        <p className={styles.panelNote}>{tr("holdings.note")}</p>
      </TabsPanel>

      {/* trades */}
      <TabsPanel value="trades">
        <div className={styles.panelHeading}><div><h2>{tr("trades.title")}</h2><p>{tr("trades.description")}</p></div></div>
        {me.trades.length === 0 ? <EmptyState icon="trades" title={tr("trades.emptyTitle")} description={tr("trades.emptyDescription")} href="/#launches" action={tr("explore")} /> : null}
        {me && me.trades.length > 0 ? (
          <div className={`${styles.tradeScroll} bb-scroll`} role="region" aria-label={tr("trades.table")} tabIndex={0}>
            <table className={styles.trades}>
              <caption className="sr-only">{tr("trades.caption")}</caption>
              <thead><tr><th scope="col">{tr("trades.side")}</th><th scope="col">{tr("trades.token")}</th><th scope="col">{tr("trades.amount")}</th><th scope="col" className={styles.usdColumn}>{tr("trades.usd")}</th><th scope="col">{tr("trades.transaction")}</th></tr></thead>
              <tbody className="font-mono tnum">
                {me.trades.map((t) => (
                  <tr key={`${t.chain}:${t.tx_hash}:${t.log_index}`} className="border-b border-line last:border-0">
                    <td><span className={styles.tradeSide} data-side={t.is_buy ? "buy" : "sell"}>{t.is_buy ? <ArrowDownLeft size={14} aria-hidden="true" /> : <ArrowUpRight size={14} aria-hidden="true" />}{t.is_buy ? tr("trades.buy") : tr("trades.sell")}</span></td>
                    <td><Link href={`/t/${t.chain}/${t.token}`}>{t.symbol}</Link> <span className={styles.tradeChain}>{CHAIN_SHORT[t.chain]}</span></td>
                    <td>{fmtQuote(t.quote_raw, t.quote_decimals, t.quote_symbol)}</td>
                    <td className={styles.usdColumn}>{t.usd !== null ? fmtUsd(t.usd) : "—"}</td>
                    <td>
                      <a href={explorerTx(t.chain, t.tx_hash)} target="_blank" rel="noreferrer" className={styles.txLink} aria-label={t.is_buy ? tr("trades.viewBuy", { symbol: t.symbol }) : tr("trades.viewSell", { symbol: t.symbol })} suppressHydrationWarning>{now ? short(t.block_time, now) : tr("trades.view")}<ArrowUpRight size={13} aria-hidden="true" /></a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </TabsPanel>
      </Tabs>

      <div className={styles.disclosure}><span>{tr("disclosureTitle")}</span><p>{tr("disclosure")}</p></div>

      {editing ? (
        <EditTokenSheet
          chain={editing.chain}
          token={editing.token}
          symbol={editing.symbol}
          initial={{ description: editing.description ?? "", image_url: editing.image_url ?? "", banner_url: editing.banner_url ?? "", website: editing.website ?? "", x_handle: editing.x_handle ?? "" }}
          onClose={() => setEditing(null)}
          onSaved={(f: EditFields) => {
            setMe((m) => (m ? { ...m, launches: m.launches.map((l) => (key(l) === key(editing) ? { ...l, description: f.description || null, image_url: f.image_url || null, banner_url: f.banner_url || null, website: f.website || null, x_handle: f.x_handle || null } : l)) } : m));
            toast({ kind: "info", title: tr("toasts.updated", { symbol: editing.symbol }) });
          }}
        />
      ) : null}
    </div>
  );
}

/** One figure in the dashboard's stats row. */
function Stat({ k, icon, v, hint, accent }: { k: string; icon: React.ReactNode; v: string; hint: string; accent?: "up" | "warm" }) {
  return (
    <div className={styles.stat}>
      <dt><span className={styles.statIcon} aria-hidden="true">{icon}</span>{k}</dt>
      <dd className={accent === "up" ? "text-up" : accent === "warm" ? "text-warm-ink" : "text-ink"}>{v}</dd>
      <dd className={styles.statHint}>{hint}</dd>
    </div>
  );
}

/** What a dashboard section shows when it has nothing yet, with the one next step. */
function EmptyState({ icon, title, description, href, action }: { icon: "launches" | "holdings" | "trades"; title: string; description: string; href: string; action: string }) {
  const Icon = icon === "launches" ? Layers3 : icon === "holdings" ? Wallet : ArrowDownLeft;
  return <div className={styles.empty}><span className={styles.emptyIcon} aria-hidden="true"><Icon size={24} strokeWidth={1.5} /></span><h3>{title}</h3><p>{description}</p><Link href={href} className={styles.outlineButton}>{action}<ArrowRight size={15} aria-hidden="true" /></Link></div>;
}
