"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createTranslator } from "use-intl/core";
import "./globals.css";
import { geist, geistMono } from "./fonts";
import { sanitizeDigest } from "@/lib/error-copy";
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, type Locale } from "@/i18n/locales";
import { en, withTranslation, type Translation } from "@/i18n/messages/en";

/** The language the switcher saved (its cookie). English without one, and on the server, which renders this page in English. */
function savedLocale(): Locale {
  const prefix = `${LOCALE_COOKIE}=`;
  const saved = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length);
  return isLocale(saved) ? saved : DEFAULT_LOCALE;
}
const serverLocale = (): Locale => DEFAULT_LOCALE;
const unchanging = () => () => {};

/**
 * Root-level error boundary. Must render its own <html>/<body> — it replaces
 * the root layout when active, so it loads the global stylesheet and font
 * variables itself instead of inheriting them. Next.js injects
 * `{ error, reset }`: `reset` re-renders from the root.
 *
 * The layout's language provider is gone with it, so the page reads the switcher's cookie itself and, for a Chinese
 * reader, loads the Chinese messages (the chunk the switcher loads). It reads in English until they arrive.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const saved = useSyncExternalStore(unchanging, savedLocale, serverLocale);
  const [translation, setTranslation] = useState<Translation | null>(null);
  useEffect(() => {
    if (saved === DEFAULT_LOCALE) return;
    let current = true;
    import("@/i18n/messages/zh-CN").then((m) => { if (current) setTranslation(m.zhCN); }, () => {});
    return () => { current = false; };
  }, [saved]);
  const locale: Locale = saved !== DEFAULT_LOCALE && translation ? saved : DEFAULT_LOCALE;
  const t = useMemo(() => createTranslator({ locale, messages: locale === DEFAULT_LOCALE ? en : withTranslation(translation ?? undefined), namespace: "info.errors", timeZone: "UTC" }), [locale, translation]);
  const digest = sanitizeDigest(error.digest);
  return (
    <html lang={locale} className={`${geist.variable} ${geistMono.variable}`}>
      <body className="min-h-screen flex flex-col">
        <main aria-label={t("pageError")} className="mx-auto max-w-3xl px-4 py-24 text-center space-y-5">
          <h1 className="font-display font-bold text-7xl">500</h1>
          <p role="alert" className="text-[15px]">{t("global")}</p>
          {digest ? (
            <p className="text-xs opacity-70">{t("errorId", { digest })}</p>
          ) : null}
          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={reset}
              className="inline-flex items-center justify-center rounded-xl px-5 min-h-11 bg-black text-white font-semibold text-sm"
            >
              {t("tryAgain")}
            </button>
            <Link href="/" className="inline-flex items-center justify-center rounded-xl px-5 min-h-11 border font-semibold text-sm">
              {t("backHome")}
            </Link>
          </div>
        </main>
      </body>
    </html>
  );
}
