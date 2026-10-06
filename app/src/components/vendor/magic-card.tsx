"use client";

// Adapted from Magic UI: https://magicui.design/r/magic-card.json (MIT, see ./LICENSES.md).
// LOCAL PATCH (openlaunch): gradient mode only, painted with the theme tokens (paper surface, line border, the glow token); the
// border glow follows the pointer and the inner spotlight is optional. Touch and reduced motion get the plain card.
import { useCallback } from "react";
import { motion, useMotionTemplate, useMotionValue } from "motion/react";
import { cn } from "@/lib/utils";

export function MagicCard({ children, className, gradientSize = 220, gradientFrom = "var(--color-glow)", gradientTo = "var(--color-glow)", spotlight = "var(--color-glow-soft)" }: { children?: React.ReactNode; className?: string; gradientSize?: number; gradientFrom?: string; gradientTo?: string; spotlight?: string | null }) {
  const mouseX = useMotionValue(-gradientSize);
  const mouseY = useMotionValue(-gradientSize);
  const move = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse") return;
    const rect = e.currentTarget.getBoundingClientRect();
    mouseX.set(e.clientX - rect.left);
    mouseY.set(e.clientY - rect.top);
  }, [mouseX, mouseY]);
  const leave = useCallback(() => { mouseX.set(-gradientSize); mouseY.set(-gradientSize); }, [mouseX, mouseY, gradientSize]);
  const border = useMotionTemplate`linear-gradient(var(--color-paper) 0 0) padding-box, radial-gradient(${gradientSize}px circle at ${mouseX}px ${mouseY}px, ${gradientFrom}, ${gradientTo}, var(--color-line) 100%) border-box`;
  const glow = useMotionTemplate`radial-gradient(${gradientSize}px circle at ${mouseX}px ${mouseY}px, ${spotlight ?? "transparent"}, transparent 100%)`;
  return (
    <motion.div className={cn("group relative isolate rounded-[inherit] border border-transparent motion-reduce:[background:var(--color-paper)]", className)} onPointerMove={move} onPointerLeave={leave} style={{ background: border }}>
      {spotlight ? <motion.div aria-hidden="true" className="pointer-events-none absolute inset-px z-0 rounded-[inherit] opacity-0 transition-opacity duration-300 group-hover:opacity-100 motion-reduce:hidden" style={{ background: glow }} /> : null}
      <div className="relative z-10 h-full rounded-[inherit]">{children}</div>
    </motion.div>
  );
}
