"use client";

import { useTranslations } from "use-intl";
import { pipsToPct } from "@/lib/launchpad/math";
import type { FeeMode } from "@/lib/launchpad/creator";

/**
 * One glance at the fee routing: "0% fee" (free pool), "1% → burned", "1% → creator".
 * Burn is the no-beneficiary default the factory registers; creator/others come from the locker recipients.
 * The mode itself is worked out in lib/launchpad/creator.ts (the token page reads it on the server); the client
 * components that import it from here keep doing so.
 */
export { feeModeOf, type FeeMode } from "@/lib/launchpad/creator";

export default function FeeChip({ lpFee, mode, className = "" }: { lpFee: number; mode: FeeMode; className?: string }) {
  const t = useTranslations("token.feeChip");
  const base = "inline-flex items-center gap-1 rounded-full border px-2 h-6 text-[11px] font-medium whitespace-nowrap";
  const pct = pipsToPct(lpFee);
  if (mode === "free")
    return (
      <span className={`${base} border-up/25 bg-up-soft text-up ${className}`} title={t("freeTitle")}>
        {t("free")}
      </span>
    );
  if (mode === "burn")
    return (
      <span className={`${base} border-warm/30 bg-warm-soft text-warm-ink ${className}`} title={t("burnTitle", { pct })}>
        {t("burn", { pct })}
      </span>
    );
  return (
    <span className={`${base} border-line bg-card text-body ${className}`} title={mode === "split" ? t("splitTitle", { pct }) : t("creatorTitle", { pct })}>
      {mode === "split" ? t("split", { pct }) : t("creator", { pct })}
    </span>
  );
}
