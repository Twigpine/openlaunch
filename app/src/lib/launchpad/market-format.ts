/** Compact ledger figures; exact values remain available in the row's title. */
export function marketUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (value > 0 && value < 0.01) return "<$0.01";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: Math.abs(value) >= 1_000 ? "compact" : "standard", maximumFractionDigits: Math.abs(value) >= 1_000 ? 1 : 2, minimumFractionDigits: 0 }).format(value);
}

/**
 * A change since launch. A token trading at twice its launch price or more reads as a multiple
 * ("19.7×" says more than "+1,870%"); smaller rises and every fall stay a signed percentage.
 */
export function marketChange(value: number): { label: string; direction: "up" | "down" | "flat" } {
  const pct = value * 100;
  if (!Number.isFinite(pct)) return { label: "—", direction: "flat" };
  const rounded = Number(pct.toFixed(Math.abs(pct) >= 10 ? 0 : 1));
  if (rounded === 0) return { label: "0.0%", direction: "flat" };
  const multiple = launchMultiple(value);
  if (multiple) return { label: multiple, direction: "up" };
  const amount = Math.abs(pct) >= 1e15 ? pct.toExponential(1) : new Intl.NumberFormat("en-US", { notation: Math.abs(pct) >= 1_000 ? "compact" : "standard", maximumFractionDigits: Math.abs(pct) >= 10 ? 0 : 1 }).format(pct);
  return { label: `${pct > 0 ? "+" : ""}${amount}%`, direction: pct > 0 ? "up" : "down" };
}

/** "2.0×", "19.7×", "245×", "1.2K×" once the price is at least double the launch price; null below that. */
export function launchMultiple(change: number): string | null {
  const x = 1 + change;
  if (!Number.isFinite(x) || x < 2) return null;
  if (x >= 1e15) return `${x.toExponential(1)}×`;
  const options: Intl.NumberFormatOptions = x >= 1_000 ? { notation: "compact", maximumFractionDigits: 1 } : x >= 100 ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  return `${new Intl.NumberFormat("en-US", options).format(x)}×`;
}
