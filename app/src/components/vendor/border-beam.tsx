"use client";

// Adapted from Magic UI: https://magicui.design/r/border-beam.json (MIT, see ./LICENSES.md).
// LOCAL PATCH (openlaunch): colours default to the theme's glow token; reduced motion shows no beam
// (a still beam reads as a stray mark on the border) by hiding it with CSS and never starting it, so the server and the
// browser render the same markup at hydration; the beam is clipped to its box so it never widens the page.
import { motion, useReducedMotion, type MotionStyle, type Transition } from "motion/react";
import { cn } from "@/lib/utils";

interface BorderBeamProps {
  size?: number;
  duration?: number;
  delay?: number;
  colorFrom?: string;
  colorTo?: string;
  transition?: Transition;
  className?: string;
  style?: React.CSSProperties;
  reverse?: boolean;
  initialOffset?: number;
  borderWidth?: number;
}

export function BorderBeam({ className, size = 50, delay = 0, duration = 6, colorFrom = "var(--color-glow)", colorTo = "var(--color-glow)", transition, style, reverse = false, initialOffset = 0, borderWidth = 1 }: BorderBeamProps) {
  const reduced = useReducedMotion();
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit] border-(length:--border-beam-width) border-transparent mask-[linear-gradient(transparent,transparent),linear-gradient(#000,#000)] mask-intersect [mask-clip:padding-box,border-box] motion-reduce:hidden"
      style={{ "--border-beam-width": `${borderWidth}px` } as React.CSSProperties}
    >
      <motion.div
        className={cn("absolute aspect-square", "bg-linear-to-l from-(--color-from) via-(--color-to) to-transparent", className)}
        style={{ width: size, offsetPath: `rect(0 auto auto 0 round ${size}px)`, "--color-from": colorFrom, "--color-to": colorTo, ...style } as MotionStyle}
        initial={{ offsetDistance: `${initialOffset}%` }}
        animate={reduced ? undefined : { offsetDistance: reverse ? [`${100 - initialOffset}%`, `${-initialOffset}%`] : [`${initialOffset}%`, `${100 + initialOffset}%`] }}
        transition={{ repeat: Infinity, ease: "linear", duration, delay: -delay, ...transition }}
      />
    </div>
  );
}
