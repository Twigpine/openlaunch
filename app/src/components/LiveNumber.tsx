"use client";

import NumberFlow, { type Format } from "@number-flow/react";

/** Whole-dollar figures that grow past a thousand read as "$14.3M"; below that, "$412". */
export const COMPACT_USD: Format = { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 };

/**
 * A live figure whose digits roll to the new value when it changes, so an update reads as
 * movement rather than a flash. The first paint is static, and visitors who prefer reduced
 * motion get the new value in place (NumberFlow honours `prefers-reduced-motion`).
 */
export default function LiveNumber({ value, format, prefix, suffix, className }: { value: number; format?: Format; prefix?: string; suffix?: string; className?: string }) {
  if (!Number.isFinite(value)) return <span className={className}>—</span>;
  return <NumberFlow value={value} format={format} prefix={prefix} suffix={suffix} locales="en-US" className={className} willChange={false} />;
}
