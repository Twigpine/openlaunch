"use client";

// Adapted from Magic UI: https://magicui.design/r/animated-list.json (MIT, see ./LICENSES.md).
// LOCAL PATCH (openlaunch): driven by real data instead of a timed reveal. The list renders the items it is given;
// an item whose key is new springs in at the top while the rest slide down, and nothing animates on the first paint.
// Reduced motion swaps the spring for an instant change.
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

export function AnimatedListItem({ children, className }: { children: ReactNode; className?: string }) {
  const reduced = useReducedMotion();
  return (
    <motion.li
      layout={reduced ? false : "position"}
      initial={reduced ? false : { scale: 0.6, opacity: 0, y: -12 }}
      animate={{ scale: 1, opacity: 1, y: 0, originY: 0 }}
      exit={reduced ? undefined : { scale: 0.9, opacity: 0, transition: { duration: 0.15 } }}
      transition={{ type: "spring", stiffness: 350, damping: 40 }}
      className={cn("w-full", className)}
    >
      {children}
    </motion.li>
  );
}

export function AnimatedList({ children, className, ...props }: ComponentPropsWithoutRef<"ol">) {
  return (
    <ol className={cn("flex flex-col gap-2", className)} {...props}>
      <AnimatePresence initial={false}>{children}</AnimatePresence>
    </ol>
  );
}
