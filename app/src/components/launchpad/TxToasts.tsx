"use client";

import Link from "next/link";
import { ArrowDownLeft, ArrowUpRight, Check, Coins, Info, Plus, X } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { useTranslations } from "use-intl";
import TokenAvatar from "./TokenAvatar";
import type { FeedItem } from "@/lib/launchpad/queries";
import { fmtQuote } from "@/lib/launchpad/math";
import { CHAIN_SHORT, DEFAULT_CHAIN } from "@/lib/chainPublic";
import { shortAddr } from "@/lib/chainPublic";
import { createToastFeedTracker, createToastQueue, dismissToast, enqueueToast, expireToast, pauseToast, removeActivityToasts, toastDelay, TOAST_TTL_MS, type ActiveToast, type QueuedToast, type ToastDetail } from "@/lib/launchpad/toast-queue";
import { getActivityNotifications, subscribeActivityNotifications } from "@/lib/launchpad/activity-preference";
import { useLive } from "./LiveProvider";

export type { ToastDetail } from "@/lib/launchpad/toast-queue";

/**
 * Global transaction toasts. Reads the shared LiveProvider feed and pops one toast
 * per NEW launch / buy / sell unless muted in notification settings (history is never replayed).
 * Local events (your own launch / trade confirming) arrive via
 * `window.dispatchEvent(new CustomEvent("bb:toast", { detail }))` and also fire
 * a confetti burst when shown. One card at a time, 6s each; hover/focus pauses.
 * Local confirmations take priority over the bounded activity backlog.
 */
export function toast(detail: ToastDetail) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<ToastDetail>("bb:toast", { detail }));
}

export default function TxToasts() {
  const { live, subscribe } = useLive();
  const t = useTranslations("activity.toasts");
  const [queue, setQueue] = useState(createToastQueue);
  const [freshFeed] = useState(() => createToastFeedTracker(live.feed ?? [], live.at));
  const active = queue.active;

  const push = useCallback((detail: ToastDetail, source: QueuedToast["source"]) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const now = Date.now();
    setQueue((cur) => enqueueToast(cur, { ...detail, id, source }, now));
  }, []);

  // Someone else's launch or trade as a card, worded in the reader's language when it arrives. An Effect Event: a
  // language switch re-renders with the new words but never re-subscribes the feed below.
  const describe = useEffectEvent((i: FeedItem): ToastDetail => {
    if (i.kind === "launch") {
      return { kind: "launch", title: t("launched", { name: i.name, chain: CHAIN_SHORT[i.chain] }), sub: `${i.symbol} · ${t("by", { address: shortAddr(i.launcher) })}${i.lp_fee === 0 ? ` · ${t("zeroFee")}` : ""}`, chain: i.chain, token: i.token, symbol: i.symbol, image: i.image_url };
    }
    const side = i.is_dev ? (i.is_buy ? "devBuy" : "devSell") : i.is_buy ? "buy" : "sell";
    return { kind: i.is_buy ? "buy" : "sell", title: t(side, { amount: fmtQuote(i.quote_wei, i.quote_decimals, i.quote_symbol), symbol: i.symbol }), sub: `${i.is_dev ? t("creatorWallet") : shortAddr(i.trader)} · ${CHAIN_SHORT[i.chain]}`, chain: i.chain, token: i.token, symbol: i.symbol, image: i.image_url };
  });

  // local events
  useEffect(() => {
    const h = (e: Event) => push((e as CustomEvent<ToastDetail>).detail, "local");
    window.addEventListener("bb:toast", h);
    return () => window.removeEventListener("bb:toast", h);
  }, [push]);

  // Keep both subscriptions stable: enabling after a hidden/offline gap first establishes a fresh baseline.
  useEffect(() => {
    let enabled = getActivityNotifications();
    let baselineNextFeed = false;
    const unsubscribePreference = subscribeActivityNotifications(() => {
      const next = getActivityNotifications();
      if (next && !enabled) baselineNextFeed = true;
      enabled = next;
      // Muting applies immediately to the backlog, without touching local updates.
      if (!enabled) {
        const now = Date.now();
        setQueue((cur) => removeActivityToasts(cur, now));
      }
    });
    const unsubscribeFeed = subscribe((snap) => {
      // A snapshot after a hidden-tab/offline gap comes back empty: missed activity is history, not news.
      const fresh = freshFeed(snap.feed ?? [], snap.at);
      // Observe while muted, including a silent first successful snapshot after re-enabling.
      if (!getActivityNotifications()) return;
      if (baselineNextFeed) {
        baselineNextFeed = false;
        return;
      }
      for (const i of fresh) push(describe(i), "activity");
    });
    return () => {
      unsubscribePreference();
      unsubscribeFeed();
    };
  }, [subscribe, freshFeed, push]);

  // Only the active card owns a timer. Pending arrivals never restart it.
  useEffect(() => {
    if (!active) return;
    const delay = toastDelay(active, Date.now());
    if (delay === null) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (wait: number) => {
      timer = setTimeout(() => {
        const now = Date.now();
        const remaining = toastDelay(active, now);
        if (remaining === null) return;
        // A timer can fire a moment early against Date.now(): expireToast would change nothing and nothing would re-arm,
        // leaving this card (and everything queued behind it) on screen until dismissed. Wait out the remainder instead.
        if (remaining > 0) {
          schedule(remaining);
          return;
        }
        setQueue((cur) => expireToast(cur, active.id, now));
      }, wait);
    };
    schedule(delay);
    return () => clearTimeout(timer);
  }, [active]);

  const pause = (reason: "hover" | "focus", paused: boolean) => {
    const now = Date.now();
    setQueue((cur) => pauseToast(cur, reason, paused, now));
  };

  return (
    <>
      {active?.celebrate ? <Confetti key={active.id} /> : null}
      <div
        className="bb-toast-region"
        aria-live="polite"
        onMouseEnter={() => pause("hover", true)}
        onMouseLeave={() => pause("hover", false)}
        onFocus={() => pause("focus", true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) pause("focus", false);
        }}
      >
        {active ? <ToastCard key={active.id} t={active} pending={queue.pending.length} onClose={() => {
          const now = Date.now();
          setQueue((cur) => dismissToast(cur, active.id, now));
        }} /> : null}
      </div>
    </>
  );
}

function ToastCard({ t, pending = 0, onClose }: { t: ActiveToast; pending?: number; onClose: () => void }) {
  const tr = useTranslations("activity.toasts");
  const EventIcon = t.kind === "buy" ? ArrowDownLeft : t.kind === "sell" ? ArrowUpRight : t.kind === "launch" ? Plus : t.kind === "collect" ? Coins : Info;
  const confirmed = t.source === "local" && t.kind !== "info";
  const eventLabel = t.kind === "info" ? tr("update") : confirmed ? tr("confirmed") : tr("live");
  const content = (
    <>
      <div className="bb-toast-body">
        <div className="bb-toast-identity" aria-hidden="true">
          {t.token && t.symbol ? <TokenAvatar chain={t.chain ?? "unknown"} token={t.token} symbol={t.symbol} image={t.image} size={40} /> : <EventIcon size={21} strokeWidth={1.8} />}
        </div>
        <div className="min-w-0">
          <p className="bb-toast-title">{t.title}</p>
          {t.sub ? <p className="bb-toast-description">{t.sub}</p> : null}
        </div>
      </div>
      <div className="bb-toast-meta">
        <span className="bb-toast-status">{confirmed ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <EventIcon size={13} strokeWidth={1.8} aria-hidden="true" />}{eventLabel}</span>
        {t.chain ? <span className="bb-toast-chain">{CHAIN_SHORT[t.chain]}</span> : null}
        {t.token ? <span className="bb-toast-destination">{tr("viewToken")} <ArrowUpRight size={13} strokeWidth={1.8} aria-hidden="true" /></span> : null}
      </div>
    </>
  );
  return (
    <div className={`bb-toast-card ${t.leaving ? "bb-toast-out" : "bb-toast-in"}`} data-kind={t.kind} style={{ animationPlayState: t.leaving && t.startedAt === null ? "paused" : "running" }}>
      {t.token ? (
        <Link href={`/t/${t.chain ?? DEFAULT_CHAIN}/${t.token}`} className="bb-toast-content">
          {content}
        </Link>
      ) : <div className="bb-toast-content">{content}</div>}
      <button
        type="button"
        onClick={onClose}
        aria-label={tr("dismiss")}
        className="bb-toast-dismiss"
      >
        <X size={16} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {pending > 0 ? <div className="bb-toast-queued" aria-live="off">{tr("queued", { count: pending })}</div> : null}
      <div className="bb-toast-timer" aria-hidden="true">
        <span className="bb-toast-progress" style={{ animationDuration: `${TOAST_TTL_MS}ms`, animationPlayState: t.startedAt === null ? "paused" : "running", opacity: t.leaving ? 0 : 1 }} />
      </div>
    </div>
  );
}

/** 24 CSS particles, one burst, no library. Positions are drawn once (lazy state) so render stays pure. */
function Confetti() {
  const colors = ["#0052FF", "#15803D", "#D97706", "#DC2626", "#0F172A"];
  const [parts] = useState(() =>
    Array.from({ length: 24 }, (_, i) => ({
      left: 50 + (Math.random() - 0.5) * 40,
      dx: (Math.random() - 0.5) * 60,
      delay: Math.random() * 0.2,
      rot: Math.random() * 720 - 360,
      color: colors[i % colors.length],
    })),
  );
  return (
    <div className="pointer-events-none fixed inset-0 z-[60] overflow-hidden" aria-hidden>
      {parts.map((p, i) => (
        <span
          key={i}
          className="bb-confetti absolute top-[45%] h-2.5 w-1.5 rounded-sm"
          style={{ left: `${p.left}%`, background: p.color, animationDelay: `${p.delay}s`, ["--dx" as string]: `${p.dx}vw`, ["--rot" as string]: `${p.rot}deg` }}
        />
      ))}
    </div>
  );
}
