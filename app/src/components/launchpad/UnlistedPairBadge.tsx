"use client";

import { useTranslations } from "use-intl";

/**
 * Marks a launch paired with an ERC-20 no list knows (lib/launchpad/unlisted-quote.ts): the pool is real and indexed,
 * but the quote's name is only what its own contract says, and it has no USD price here. A client component, so it reads
 * in the reader's language on the server-rendered token page as in the client lists.
 */
export default function UnlistedPairBadge({ symbol, className = "" }: { symbol: string; className?: string }) {
  const t = useTranslations("token.badges");
  return (
    <span className={`inline-flex h-5 items-center rounded-full border border-warm/30 bg-warm-soft px-2 text-[10px] font-medium text-warm-ink ${className}`} title={t("unlistedTitle", { symbol })}>
      {t("unlisted")}
    </span>
  );
}
