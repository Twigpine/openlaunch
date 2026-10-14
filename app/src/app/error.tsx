"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useTranslations } from "use-intl";
import { btn } from "@/components/ui";
import { sanitizeDigest } from "@/lib/error-copy";

/** Route-level error boundary. Next.js injects `{ error, reset }`: `reset` re-renders the route segment so failed server data is fetched again. */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("info.errors");
  useEffect(() => {
    console.error(error);
  }, [error]);
  const digest = sanitizeDigest(error.digest);
  return (
    <main aria-label={t("pageError")} className="mx-auto max-w-3xl px-4 py-24 text-center space-y-5">
      <h1 className="font-display font-bold text-7xl text-brand-soft [text-shadow:0_1px_0_#d6d3d1]">500</h1>
      <p role="alert" className="text-[15px] text-body">{t("route")}</p>
      {digest ? (
        <p className="text-xs text-muted">{t("errorId", { digest })}</p>
      ) : null}
      <div className="flex items-center justify-center gap-3">
        <button type="button" onClick={reset} className={btn.primary}>
          {t("tryAgain")}
        </button>
        <Link href="/" className={btn.secondary}>
          {t("backHome")}
        </Link>
      </div>
    </main>
  );
}
