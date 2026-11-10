"use client";

import { useCallback } from "react";
import { useTranslations } from "use-intl";
import { agoParts } from "@/lib/launchpad/time";

/**
 * Relative time in the reader's language: `short` is the compact count ("3m", "3分钟"), `ago` the phrase ("3m ago",
 * "3分钟前"). The arithmetic is `agoParts`, so English reads exactly as `ago()` did.
 */
export function useAgo() {
  const t = useTranslations("common.time");
  const short = useCallback((iso: string, now: number) => {
    const { n, unit } = agoParts(iso, now);
    return t(unit, { n });
  }, [t]);
  const ago = useCallback((iso: string, now: number) => t("ago", { time: short(iso, now) }), [t, short]);
  return { short, ago };
}
