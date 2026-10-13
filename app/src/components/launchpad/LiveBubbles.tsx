"use client";

import Link from "next/link";
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { forceCollide, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import TokenAvatar from "./TokenAvatar";
import { ChainCorner } from "./ChainLogo";
import { BUBBLE_MAX, bubbleLean, bubbleRadii, bubbleVolume, type BubbleLean, type BubbleToken } from "@/lib/launchpad/bubbles";
import { feedKey, riverUsd, type RiverEntry } from "@/lib/launchpad/river";
import { CHAIN_SHORT } from "@/lib/chainPublic";
import { ago } from "@/lib/launchpad/time";
import { setPendingToken } from "@/lib/launchpad/token-transition";
import styles from "./LiveBubbles.module.css";

/** Layout before the field is measured: the server render and the first client paint must agree. Heights mirror LiveBubbles.module.css. */
const ESTIMATED = { w: 760, h: 320 };
/** The newest live trades that fly a spark at once. */
const SPARKS = 14;
const CARD_W = 236;
const TONE: Record<BubbleLean["side"], string> = { buy: "var(--color-up)", sell: "var(--color-down)", even: "var(--color-muted)", new: "var(--color-brand)" };

type Node = SimulationNodeDatum & { id: string; r: number };
type Placed = { x: number; y: number; r: number };
type Spark = { key: string; side: "buy" | "sell"; dx: number; dy: number };

const idOf = (entry: RiverEntry) => `${entry.item.chain}:${entry.item.token.toLowerCase()}`;

/** A stable number in [0, 1) from a string: seeds a bubble's first place, its float rhythm and a spark's angle. */
function hash01(s: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10_000) / 10_000;
}

/**
 * Lay the bubbles out with d3-force, run to rest right here: the simulation is stopped at once and ticked by hand, so
 * no animation timer ever runs. Each bubble starts from a place seeded by its own id, so the same tokens always settle
 * the same way and an update moves a bubble only as far as the data changed; CSS glides it there.
 */
function layout(tokens: readonly BubbleToken[], radii: readonly number[], w: number, h: number): Map<string, Placed> {
  const nodes: Node[] = tokens.map((t, i) => ({ id: t.id, r: radii[i], x: w / 2 + (hash01(t.id, 1) - 0.5) * w * 0.7, y: h / 2 + (hash01(t.id, 2) - 0.5) * h * 0.6 }));
  const sim = forceSimulation(nodes)
    .force("x", forceX<Node>(w / 2).strength(0.045))
    .force("y", forceY<Node>(h / 2).strength(0.11))
    .force("collide", forceCollide<Node>((n) => n.r + 4).strength(1).iterations(3))
    .stop();
  for (let i = 0; i < 240; i++) {
    sim.tick();
    // the field's walls: a bubble never leaves it
    for (const n of nodes) {
      n.x = Math.min(w - n.r - 2, Math.max(n.r + 2, n.x ?? w / 2));
      n.y = Math.min(h - n.r - 2, Math.max(n.r + 2, n.y ?? h / 2));
    }
  }
  return new Map(nodes.map((n) => [n.id, { x: n.x ?? w / 2, y: n.y ?? h / 2, r: n.r }]));
}

/**
 * The tokens traded or launched in the window, as bubbles: area for the dollars traded, colour for the side that led.
 * A live trade flies a spark into its bubble (a buy) or out of it (a sell) and the bubble pulses; a live launch pops
 * in. Decorative for assistive tech, like the river: the list view carries the same events as links.
 */
export default function LiveBubbles({ tokens, entries, now, complete }: { tokens: readonly BubbleToken[]; entries: readonly RiverEntry[]; now: number; complete: boolean }) {
  const field = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    const el = field.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setSize({ w: Math.round(entry.contentRect.width), h: Math.round(entry.contentRect.height) }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { w, h } = size ?? ESTIMATED;
  const compact = w < 520;
  const shown = useMemo(() => tokens.slice(0, compact ? BUBBLE_MAX.compact : BUBBLE_MAX.wide), [tokens, compact]);
  const radii = useMemo(() => bubbleRadii(shown, w * h, compact ? { min: 15, max: 60 } : { min: 17, max: 84 }), [shown, w, h, compact]);
  const placed = useMemo(() => layout(shown, radii, w, h), [shown, radii, w, h]);

  // what arrived live (never the first paint): the newest arrival per token pulses its bubble, a fresh launch pops in,
  // and the newest few trades each fly a spark. Entries come newest first.
  const live = useMemo(() => {
    const pulse = new Map<string, string>();
    const born = new Set<string>();
    const sparks = new Map<string, Spark[]>();
    let flying = 0;
    for (const entry of entries) {
      if (!entry.fresh) continue;
      const id = idOf(entry);
      const key = feedKey(entry.item);
      if (!pulse.has(id)) pulse.set(id, key);
      if (entry.item.kind === "launch") { born.add(id); continue; }
      if (flying >= SPARKS) continue;
      flying += 1;
      const angle = hash01(key, 5) * Math.PI * 2;
      const r = placed.get(id)?.r ?? 20;
      const reach = r + 30;
      sparks.set(id, [...(sparks.get(id) ?? []), { key, side: entry.item.is_buy ? "buy" : "sell", dx: Math.round(Math.cos(angle) * reach), dy: Math.round(Math.sin(angle) * reach) }]);
    }
    return { pulse, born, sparks };
  }, [entries, placed]);

  const hovered = hover ? shown.find((t) => t.id === hover) : undefined;
  const at = hovered ? placed.get(hovered.id) : undefined;

  return (
    // the card lives outside the clipped field, so it can open past the field's edge instead of being cut off
    <div className="relative">
      <div ref={field} aria-hidden="true" className={styles.field}>
        {shown.map((t) => {
          const p = placed.get(t.id);
          return p ? <Bubble key={t.id} t={t} p={p} pulse={live.pulse.get(t.id) ?? null} born={live.born.has(t.id)} sparks={live.sparks.get(t.id) ?? []} onEnter={setHover} onLeave={(id) => setHover((cur) => (cur === id ? null : cur))} /> : null;
        })}
        {shown.length === 0 ? (
          <div className={styles.empty}>
            <p className="text-sm font-medium text-ink">Nothing traded or launched in the last 24 hours</p>
            <p className="text-xs text-muted">New ones show up here as they happen.</p>
          </div>
        ) : null}
      </div>
      <AnimatePresence>
        {hovered && at ? <BubbleCard key={hovered.id} t={hovered} p={at} w={w} h={h} now={now} complete={complete} /> : null}
      </AnimatePresence>
    </div>
  );
}

const Bubble = memo(function Bubble({ t, p, pulse, born, sparks, onEnter, onLeave }: { t: BubbleToken; p: Placed; pulse: string | null; born: boolean; sparks: Spark[]; onEnter: (id: string) => void; onLeave: (id: string) => void }) {
  const lean = bubbleLean(t);
  const roomy = p.r >= 34;
  const trades = t.buys + t.sells;
  const value = bubbleVolume(t) > 0 ? riverUsd(bubbleVolume(t)) : trades ? `${trades} ${trades === 1 ? "trade" : "trades"}` : "New";
  const style = {
    "--x": p.x, "--y": p.y, "--r": p.r, "--tone": TONE[lean.side],
    "--k": lean.side === "even" ? 0.2 : lean.strength,
    "--float": `${5 + hash01(t.id, 3) * 4}s`, "--float-delay": `-${(hash01(t.id, 4) * 6).toFixed(2)}s`,
  } as CSSProperties;
  return (
    <Link
      href={`/t/${t.chain}/${t.token}`}
      prefetch={false}
      tabIndex={-1}
      onClick={() => setPendingToken({ chain: t.chain, token: t.token, name: t.name, symbol: t.symbol, image: t.image_url })}
      onPointerEnter={(e) => { if (e.pointerType === "mouse") onEnter(t.id); }}
      onPointerLeave={() => onLeave(t.id)}
      className={styles.bubble}
      data-side={lean.side}
      style={style}
    >
      <span className={`${styles.orb} ${born ? styles.born : ""}`}>
        {/* keyed by the arrival, so each new trade replays the ring */}
        {pulse ? <span key={pulse} className={styles.pulse} /> : null}
        <span className={styles.logo}>
          <TokenAvatar chain={t.chain} token={t.token} symbol={t.symbol} image={t.image_url} size={Math.round(roomy ? Math.min(46, p.r * 0.58) : p.r * 1.3)} className="rounded-full" />
          {roomy ? <ChainCorner chain={t.chain} size={Math.round(Math.min(15, p.r * 0.2))} /> : null}
        </span>
        {roomy ? <><span className={styles.symbol}>{t.symbol}</span><span className={styles.value}>{value}</span></> : null}
      </span>
      {sparks.map((s) => <span key={s.key} className={styles.spark} data-side={s.side} style={{ "--dx": `${s.dx}px`, "--dy": `${s.dy}px`, "--tone": s.side === "buy" ? "var(--color-up)" : "var(--color-down)" } as CSSProperties} />)}
    </Link>
  );
});

/** What a bubble holds, on hover: both sides in dollars, the trade count, and when it last moved. */
function BubbleCard({ t, p, w, h, now, complete }: { t: BubbleToken; p: Placed; w: number; h: number; now: number; complete: boolean }) {
  const reduced = useReducedMotion();
  const below = p.y < h * 0.45;
  const left = Math.min(Math.max(p.x, CARD_W / 2 + 6), w - CARD_W / 2 - 6);
  const from = { opacity: 0, scale: 0.92, y: below ? -6 : 6 };
  const trades = t.buys + t.sells;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute z-20" style={{ left, top: below ? p.y + p.r + 10 : p.y - p.r - 10, width: CARD_W, transform: `translate(-50%, ${below ? "0" : "-100%"})` }}>
      <motion.div
        initial={reduced ? false : from}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { ...from, transition: { duration: 0.12 } }}
        transition={{ type: "spring", stiffness: 420, damping: 28 }}
        style={{ transformOrigin: below ? "50% 0%" : "50% 100%" }}
        className="rounded-2xl border border-line bg-raised p-3 shadow-dialog"
      >
        <div className="flex items-center gap-2.5">
          <span className="relative shrink-0">
            <TokenAvatar chain={t.chain} token={t.token} symbol={t.symbol} image={t.image_url} size={32} className="rounded-full" />
            <ChainCorner chain={t.chain} size={13} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold leading-tight text-ink">{t.name}</span>
            <span className="block truncate text-[11px] leading-tight text-muted">{t.symbol} on {CHAIN_SHORT[t.chain]}</span>
          </span>
          <span className="shrink-0 self-start font-mono text-[10px] text-muted" suppressHydrationWarning>{ago(new Date(t.lastAt).toISOString(), now)}</span>
        </div>
        {trades ? (
          <dl className="mt-2.5 grid grid-cols-2 gap-2 border-t border-line pt-2.5 text-[11px]">
            <div><dt className="text-muted">Bought</dt><dd className="font-mono text-[13px] font-semibold text-up">{riverUsd(t.bought)}</dd></div>
            <div><dt className="text-muted">Sold</dt><dd className="font-mono text-[13px] font-semibold text-down-ink">{riverUsd(t.sold)}</dd></div>
          </dl>
        ) : null}
        <p className="mt-2 text-[11px] text-muted">
          {trades ? `${trades.toLocaleString("en-US")} ${trades === 1 ? "trade" : "trades"} ${complete ? "in this window" : "in view"}` : "Launched, no trades yet"}
          {t.unpriced ? `, ${t.unpriced} with no dollar price` : ""}
          {trades && t.launched ? ". Launched in this window" : ""}
        </p>
      </motion.div>
    </div>
  );
}
