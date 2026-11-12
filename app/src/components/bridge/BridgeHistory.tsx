"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useAccount } from "wagmi";
import { ArrowUpRight, RotateCw } from "lucide-react";
import { BRIDGE_CHAINS, type BridgeChainId } from "@/lib/bridge/types";
import { SIGNAL_CODES, SIGNAL_COLORS } from "@/lib/bridge/signal";
import { BRIDGE_HISTORY_LIMIT, formatHistoryAmount, historyReceived, historySettled, historyStatus, mergeHistory, validateHistoryResponse, type BridgeHistoryEntry } from "@/lib/bridge/history";
import { bridgeHistoryKey } from "@/lib/bridge/history-store";
import { shortAddr } from "@/lib/chainPublic";
import { bridgeLedger } from "./history-ledger";
import { dotFont } from "./dot-font";
import styles from "./History.module.css";

type Remote = { wallet: string; key: string; state: "off" | "on" | "error"; transfers: BridgeHistoryEntry[] };
const NO_ROWS: BridgeHistoryEntry[] = [];
// A board shows the time large and the day under it, in the reader's own locale and a 24-hour clock.
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const DAY = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const codeColor = (chain: BridgeChainId) => ({ "--code": SIGNAL_COLORS[chain].join(" ") }) as React.CSSProperties;

/**
 * "Your transfers" on /bridge: a departures board for the connected wallet. It reads this browser's ledger (written by
 * the bridge controller) and, when the server has a Relay key, Relay's own list for the wallet. It never sends or
 * changes anything, so it can sit beside the panel without a second bridge controller.
 */
export default function BridgeHistory() {
  const { address } = useAccount();
  const wallet = address?.toLowerCase() ?? "";
  const snapshot = useSyncExternalStore(bridgeLedger.subscribe, bridgeLedger.getSnapshot, bridgeLedger.getServerSnapshot);
  const local = snapshot.entries[wallet] ?? NO_ROWS;
  const unsaved = !!snapshot.unsaved[wallet];
  const [revision, setRevision] = useState(0);
  const [remote, setRemote] = useState<Remote | null>(null);
  // Ask Relay again whenever one of this browser's transfers settles, so its row picks up the delivered amount.
  const settled = local.filter((row) => historySettled(row.status)).length;
  const key = wallet ? `${wallet}:${revision}:${settled}` : "";

  useEffect(() => {
    if (!address) return;
    bridgeLedger.read(address);
    const onStorage = (event: StorageEvent) => { if (event.key === null || event.key === bridgeHistoryKey(address)) bridgeLedger.read(address); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [address, revision]);

  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    fetch(`/api/bridge/history?address=${wallet}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("history");
        return validateHistoryResponse(await response.json());
      })
      .then((body) => setRemote({ wallet, key, state: body.relay, transfers: body.relay === "on" ? body.transfers : [] }))
      .catch(() => { if (!controller.signal.aborted) setRemote((prior) => ({ wallet, key, state: "error", transfers: prior?.wallet === wallet ? prior.transfers : [] })); });
    return () => controller.abort();
  }, [key, wallet]);

  const current = remote?.wallet === wallet ? remote : null;
  const loading = !!wallet && current?.key !== key;
  const rows = mergeHistory(local, current?.transfers ?? NO_ROWS);
  const note = !wallet ? "Transfers from the connected wallet appear here."
    : current?.state === "on" ? `From Relay for this wallet, plus what this browser saved. The latest ${BRIDGE_HISTORY_LIMIT} are shown.`
    : current?.state === "error" ? "Relay's list did not load, so this shows what this browser saved. Try again in a moment."
    : current?.state === "off" ? "Saved in this browser. Transfers sent from another device or browser are not listed."
    : "Loading your transfers…";

  return <HistoryBoard wallet={wallet} rows={rows} loading={loading} note={note} unsaved={unsaved} onRefresh={() => setRevision((value) => value + 1)} />;
}

/** The board itself, from plain props, so the development fixture can show every state without a wallet. */
export function HistoryBoard({ wallet, rows, loading, note, unsaved, onRefresh }: { wallet: string; rows: readonly BridgeHistoryEntry[]; loading: boolean; note: string; unsaved: boolean; onRefresh: () => void }) {
  return (
    <section id="transfers" className={`${styles.history} ${dotFont.variable}`} aria-labelledby="bridge-transfers" tabIndex={-1}>
      <div className={styles.head}>
        <div>
          <h2 id="bridge-transfers">Your transfers</h2>
          <p>{note}</p>
        </div>
        <button type="button" className={styles.refresh} disabled={!wallet || loading} data-busy={loading || undefined} onClick={onRefresh}>
          <RotateCw size={14} aria-hidden />{loading ? "Checking" : "Refresh"}
        </button>
      </div>
      <div className={styles.board}>
        {!wallet ? <Empty title="No wallet" body="Connect a wallet in the panel above to see its transfers." />
          : rows.length === 0 ? (loading ? <Empty title="Loading" body="Reading this wallet's transfers." /> : <Empty title="No transfers" body="Transfers you send from this wallet will show up on this board." />)
          : <>
            <div className={styles.columns} aria-hidden><span>Time</span><span>Route</span><span>Sent</span><span>Received</span><span>Status</span><span /></div>
            <ol className={styles.list} aria-label="Transfers, newest first">{rows.map((entry) => <Row key={entry.requestId} entry={entry} />)}</ol>
          </>}
        {wallet && unsaved ? <p className={styles.notice} role="status">This browser is not saving bridge history, so this list clears when you leave the page.</p> : null}
      </div>
    </section>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return <div className={styles.empty}><strong>{title}</strong><span>{body}</span></div>;
}

function Row({ entry }: { entry: BridgeHistoryEntry }) {
  const origin = BRIDGE_CHAINS[entry.originChainId];
  const destination = BRIDGE_CHAINS[entry.destinationChainId];
  const status = historyStatus(entry);
  const received = historyReceived(entry);
  const when = new Date(entry.createdAt);
  return (
    <li className={styles.row} data-tone={status.tone}>
      <time className={styles.time} dateTime={when.toISOString()}>{CLOCK.format(when)}<small>{DAY.format(when)}</small></time>
      <span className={styles.route}>
        <span className={styles.code} style={codeColor(entry.originChainId)} aria-hidden>{SIGNAL_CODES[entry.originChainId]}</span>
        <span className={styles.track} aria-hidden />
        <span className={styles.code} style={codeColor(entry.destinationChainId)} aria-hidden>{SIGNAL_CODES[entry.destinationChainId]}</span>
        <span className="sr-only">{origin.name} to {destination.name}</span>
      </span>
      <span className={`${styles.amount} ${styles.sent}`}><small>Sent</small>{formatHistoryAmount(entry.amountIn, entry.inDecimals)} {entry.originAsset}</span>
      <span className={`${styles.amount} ${styles.received}`} data-note={received.note ? "" : undefined} data-kind={received.label === "Quoted" ? "quoted" : undefined}><small>{received.label}</small>{received.amount ?? received.note}</span>
      <span className={styles.status}>{status.label}</span>
      <span className={styles.links}>
        {entry.provider === "cctp" ? <span className={styles.via}>Circle</span> : <a href={`https://relay.link/transaction/${entry.requestId}`} target="_blank" rel="noreferrer">Relay<ArrowUpRight size={12} aria-hidden /></a>}
        {entry.sourceHash ? <a href={`${origin.explorer}/tx/${entry.sourceHash}`} target="_blank" rel="noreferrer">Source<ArrowUpRight size={12} aria-hidden /></a> : null}
        {entry.status === "success" && entry.destinationHashes[0] ? <a href={`${destination.explorer}/tx/${entry.destinationHashes[0]}`} target="_blank" rel="noreferrer">Destination<ArrowUpRight size={12} aria-hidden /></a> : null}
      </span>
      {entry.recipient ? <span className={styles.recipient}>Sent to {shortAddr(entry.recipient)}, not this wallet</span> : null}
    </li>
  );
}
