"use client";

import { useEffect, useRef } from "react";
import { SIGNAL_CODES, SIGNAL_COLORS, SIGNAL_OK, SIGNAL_ROWS, SIGNAL_WARN, codeLights, routeLight, signalLayout, signalPitch, type SignalMode, type SignalPitch } from "@/lib/bridge/signal";
import type { BridgeChainId } from "@/lib/bridge/types";
import styles from "./Signal.module.css";

type Rgb = readonly [number, number, number];
const rgb = (c: Rgb) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
const blend = (a: Rgb, b: Rgb, t: number): Rgb => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];

/**
 * The bridge's LED strip: the two networks spelled in dots and a row of route lights between them. Decorative
 * (aria-hidden): what it shows is computed from the transfer state in lib/bridge/signal.ts, and the panel's own text
 * says the same thing in words. Drawn on a canvas, animated only while mounted and never under reduced motion.
 */
export default function SignalBoard({ from, to, mode, caption }: { from: BridgeChainId; to: BridgeChainId | null; mode: SignalMode; caption: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // the board's width is read from a zero-height sibling: sizing the canvas must not re-trigger its own observer
  const ruler = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const node = canvas.current;
    const rule = ruler.current;
    const context = node?.getContext("2d");
    if (!node || !rule || !context) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const started = performance.now();
    let frame = 0;
    let width = 0;
    let pitch = 6;
    let chosen: SignalPitch | null = null;
    let inset = 0;
    let layout = signalLayout(70, SIGNAL_CODES[from], to === null ? null : SIGNAL_CODES[to]);

    const measure = () => {
      const next = rule.clientWidth;
      if (!next || next === width) return;
      width = next;
      chosen = signalPitch(width, chosen);
      pitch = chosen.pitch;
      const cols = Math.floor(width / pitch);
      inset = (width - cols * pitch) / 2;
      layout = signalLayout(cols, SIGNAL_CODES[from], to === null ? null : SIGNAL_CODES[to]);
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const height = SIGNAL_ROWS * pitch;
      node.style.height = `${height}px`;
      node.width = Math.round(width * ratio);
      node.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const paint = (now: number) => {
      if (!width) return;
      const seconds = still ? 0 : (now - started) / 1000;
      const radius = pitch * 0.3;
      const dot = (x: number, y: number, size: number) => { context.beginPath(); context.arc(inset + x * pitch + pitch / 2, y * pitch + pitch / 2, size, 0, 6.2832); context.fill(); };
      context.clearRect(0, 0, width, SIGNAL_ROWS * pitch);
      // the unlit grid breathes slightly so the board reads as powered
      context.fillStyle = "rgb(142, 162, 200)";
      for (let y = 0; y < layout.rows; y++) for (let x = 0; x < layout.cols; x++) {
        context.globalAlpha = 0.07 + (still ? 0 : 0.03 * Math.sin(x * 0.33 + y * 0.52 + seconds * 1.1));
        dot(x, y, radius * 0.8);
      }
      const codes = codeLights(mode, seconds);
      const fromColor = SIGNAL_COLORS[from];
      const chainTo = to === null ? fromColor : SIGNAL_COLORS[to];
      context.fillStyle = rgb(fromColor);
      for (const [x, y] of layout.from) { context.globalAlpha = Math.min(1, Math.max(0, codes.from)) * (still ? 1 : 0.9 + 0.1 * Math.sin(seconds * 2.2 + x * 0.5)); dot(x, y, radius); }
      context.fillStyle = rgb(codes.toTone === "ok" ? SIGNAL_OK : codes.toTone === "warn" ? SIGNAL_WARN : chainTo);
      context.globalAlpha = Math.min(1, Math.max(0, codes.to));
      for (const [x, y] of layout.to) dot(x, y, radius);
      const count = layout.path.length;
      layout.path.forEach(([x, y], index) => {
        const light = routeLight(mode, seconds, index, count);
        context.fillStyle = rgb(light.tone === "ok" ? SIGNAL_OK : light.tone === "warn" ? SIGNAL_WARN : blend(fromColor, chainTo, count > 1 ? index / (count - 1) : 0));
        context.globalAlpha = light.level;
        dot(x, y, radius * (1 + 0.3 * light.level));
      });
      context.globalAlpha = 1;
    };

    const loop = (now: number) => { paint(now); frame = requestAnimationFrame(loop); };
    const observer = new ResizeObserver(() => { measure(); if (still) paint(started); });
    observer.observe(rule);
    measure();
    if (still) paint(started);
    else frame = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [from, to, mode]);

  return (
    <div className={styles.board} aria-hidden="true">
      <span ref={ruler} className={styles.boardRuler} />
      <canvas ref={canvas} className={styles.boardCanvas} />
      <p className={styles.caption} data-mode={mode}>
        {[...caption].map((character, index) => <span key={`${caption}:${index}`} style={{ animationDelay: `${index * 16}ms` }}>{character === " " ? " " : character}</span>)}
      </p>
    </div>
  );
}
