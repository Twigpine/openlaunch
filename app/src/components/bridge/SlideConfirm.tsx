"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { SLIDE_CONFIRM_AT, slideKey, slideProgress, slideRelease, slideTurns } from "@/lib/bridge/slide";
import styles from "./Signal.module.css";

const COIN = 52;
const PAD = 6;

/**
 * Slide to confirm: drag the coin to the far end and let go. The rules live in lib/bridge/slide.ts: only a release (or
 * Enter) at the end calls `onConfirm`; letting go anywhere else puts the coin back and requests nothing. It is an
 * extra way to confirm, never the only one: the form keeps its ordinary button beside it. The coin shows the token
 * being sent and turns to the token received when the two differ.
 */
export default function SlideConfirm({ label, front, back, onConfirm }: { label: string; front: ReactNode; back: ReactNode | null; onConfirm: () => void }) {
  const track = useRef<HTMLDivElement>(null);
  const grab = useRef(0);
  // the live drag, read by the handlers: a quick flick can let go before React has re-rendered the last move
  const live = useRef({ dragging: false, progress: 0 });
  const [travel, setTravel] = useState(0);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [putBack, setPutBack] = useState(false);

  useEffect(() => {
    const node = track.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setTravel(Math.max(0, node.clientWidth - COIN - PAD * 2)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const armed = progress >= SLIDE_CONFIRM_AT;
  const offset = progress * travel;
  const turn = back ? Math.min(1, Math.max(0, (progress - 0.35) / 0.3)) * 180 : 0;

  function place(value: number) {
    live.current.progress = value;
    setProgress(value);
  }
  function down(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // capture keeps the drag alive when the pointer leaves the coin; a wallet webview that refuses it still drags inside the coin
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
    grab.current = event.clientX - event.currentTarget.getBoundingClientRect().left;
    live.current = { dragging: true, progress: live.current.progress };
    setDragging(true);
    setPutBack(false);
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    if (!live.current.dragging || !track.current) return;
    place(slideProgress(event.clientX, track.current.getBoundingClientRect().left + PAD, grab.current, travel));
  }
  function up() {
    if (!live.current.dragging) return;
    const at = live.current.progress;
    live.current.dragging = false;
    setDragging(false);
    if (slideRelease(at) === "confirm") { place(1); onConfirm(); return; }
    setPutBack(at > 0);
    place(0);
  }
  function cancel() {
    if (!live.current.dragging) return;
    live.current.dragging = false;
    setDragging(false);
    place(0);
  }
  function key(event: KeyboardEvent<HTMLDivElement>) {
    const next = slideKey(live.current.progress, event.key);
    if (!next) return;
    event.preventDefault();
    setPutBack(false);
    if (next.confirm) onConfirm();
    else place(next.progress);
  }

  const hint = armed ? (dragging ? "Let go to confirm." : "Press Enter to confirm.")
    : dragging ? "Keep going. Let go now and nothing is sent."
    : putBack ? "Nothing was sent. Drag all the way across to confirm."
    : progress > 0 ? "Keep going with the right arrow, then press Enter."
    : "Drag the coin across to confirm, or use the button below.";

  return (
    <div className={styles.slide}>
      <div ref={track} className={styles.slideTrack} data-armed={armed || undefined}>
        <span className={styles.slideFill} data-settle={!dragging || undefined} style={{ width: offset + COIN + PAD * 2 }} />
        <span className={styles.slideLabel} style={{ opacity: Math.max(0, 1 - progress * 2.4) }}>{label}</span>
        <div
          role="slider" tabIndex={0} aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}
          aria-valuetext={armed ? "At the end. Press Enter to confirm." : `${Math.round(progress * 100)} percent across`}
          className={styles.coin} data-settle={!dragging || undefined} data-dragging={dragging || undefined} style={{ transform: `translateX(${offset}px)` }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onKeyDown={key}
        >
          <span className={styles.coinBody} style={{ transform: `rotateZ(${progress * slideTurns(travel, COIN) * 360}deg) rotateY(${turn}deg)`, "--sheen": `${20 + progress * 540}deg` } as CSSProperties}>
            <span className={`${styles.coinFace} ${styles.coinFront}`}>{front}</span>
            {back ? <span className={`${styles.coinFace} ${styles.coinBack}`}>{back}</span> : null}
          </span>
        </div>
      </div>
      <p className={styles.slideHint} aria-live="polite">{hint}</p>
    </div>
  );
}
