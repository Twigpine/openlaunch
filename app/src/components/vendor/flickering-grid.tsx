"use client";

// Adapted from Magic UI: https://magicui.design/r/flickering-grid.json (MIT, see ./LICENSES.md).
// LOCAL PATCH (openlaunch): the colour is a CSS colour or variable read from the page (so it follows the theme toggle),
// reduced motion draws one still frame, a hidden tab stops drawing, and frames are capped at ~30fps.
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

interface FlickeringGridProps extends React.HTMLAttributes<HTMLDivElement> {
  squareSize?: number;
  gridGap?: number;
  flickerChance?: number;
  /** Any CSS colour, including `var(--token)`; resolved against the element so a theme change repaints it. */
  color?: string;
  maxOpacity?: number;
}

export function FlickeringGrid({ squareSize = 4, gridGap = 6, flickerChance = 0.3, color = "var(--color-brand)", maxOpacity = 0.3, className, ...props }: FlickeringGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!container || !canvas || !ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let rgb = "0, 0, 0";
    const readColor = () => {
      const probe = document.createElement("span");
      probe.style.color = color;
      container.appendChild(probe);
      const parsed = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g);
      probe.remove();
      if (parsed && parsed.length >= 3) rgb = `${parsed[0]}, ${parsed[1]}, ${parsed[2]}`;
    };
    let cols = 0, rows = 0, dpr = 1;
    let squares = new Float32Array(0);
    const setup = () => {
      dpr = window.devicePixelRatio || 1;
      const width = container.clientWidth, height = container.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      cols = Math.ceil(width / (squareSize + gridGap));
      rows = Math.ceil(height / (squareSize + gridGap));
      squares = new Float32Array(cols * rows);
      for (let i = 0; i < squares.length; i++) squares[i] = Math.random() * maxOpacity;
    };
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          ctx.fillStyle = `rgba(${rgb}, ${squares[i * rows + j]})`;
          ctx.fillRect(i * (squareSize + gridGap) * dpr, j * (squareSize + gridGap) * dpr, squareSize * dpr, squareSize * dpr);
        }
      }
    };
    readColor();
    setup();
    draw();

    let frame = 0, last = 0, visible = false;
    const tick = (time: number) => {
      frame = 0;
      if (!visible || document.hidden || reduced.matches) return;
      if (time - last >= 33) {
        const delta = Math.min(0.1, (time - last) / 1000);
        last = time;
        for (let i = 0; i < squares.length; i++) if (Math.random() < flickerChance * delta) squares[i] = Math.random() * maxOpacity;
        draw();
      }
      frame = requestAnimationFrame(tick);
    };
    const start = () => { if (!frame && visible && !document.hidden && !reduced.matches) frame = requestAnimationFrame(tick); };
    const io = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; start(); });
    io.observe(canvas);
    const ro = new ResizeObserver(() => { setup(); draw(); });
    ro.observe(container);
    const theme = new MutationObserver(() => { readColor(); draw(); });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    document.addEventListener("visibilitychange", start);
    reduced.addEventListener("change", start);
    return () => { cancelAnimationFrame(frame); io.disconnect(); ro.disconnect(); theme.disconnect(); document.removeEventListener("visibilitychange", start); reduced.removeEventListener("change", start); };
  }, [squareSize, gridGap, flickerChance, color, maxOpacity]);

  return (
    <div ref={containerRef} aria-hidden="true" className={cn("h-full w-full", className)} {...props}>
      <canvas ref={canvasRef} className="pointer-events-none" />
    </div>
  );
}
