"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "use-intl";
import { Languages } from "lucide-react";
import { LOCALE_COOKIE, LOCALE_NAMES, LOCALES, type Locale } from "@/i18n/locales";

/** Remember the choice for a year and re-render the page in it; the URL stays the same in every language. */
function useSwitchLocale() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const choose = (next: Locale) => {
    const secure = window.location.protocol === "https:" ? "; secure" : "";
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax${secure}`;
    startTransition(() => router.refresh());
  };
  return { pending, choose };
}

/**
 * Language switch. In the header rail it is one compact tool that names the other language in that language ("中"
 * for Chinese, "EN" for English), so a reader of either can find it; in the phone menu it is a labelled settings row.
 */
export default function LanguageSwitcher({ block = false }: { block?: boolean }) {
  const t = useTranslations("header.language");
  const locale = useLocale();
  const { pending, choose } = useSwitchLocale();
  const next = LOCALES.find((l) => l !== locale) ?? locale;
  const label = t("switchTo", { language: LOCALE_NAMES[next] });

  if (!block) {
    return (
      <button
        type="button"
        onClick={() => choose(next)}
        disabled={pending}
        aria-label={label}
        title={label}
        lang={next}
        className="inline-flex h-7.5 min-w-7.5 shrink-0 items-center justify-center rounded-full px-[7px] text-[12px] font-semibold text-body transition-colors hover:bg-line hover:text-ink disabled:opacity-60 motion-reduce:transition-none"
      >
        {next === "zh-CN" ? "中" : "EN"}
      </button>
    );
  }

  // a settings row like Theme beside it: icon and label left, the other language as the control on the right
  return (
    <div className="min-h-12 px-3 flex items-center gap-3 rounded-xl text-[15px] font-medium text-ink">
      <Languages size={17} strokeWidth={1.8} aria-hidden className="shrink-0" />
      <span>
        {t("label")} <span className="text-muted">· {LOCALE_NAMES[locale]}</span>
      </span>
      <button
        type="button"
        onClick={() => choose(next)}
        disabled={pending}
        aria-label={label}
        lang={next}
        className="ml-auto h-9 px-3.5 inline-flex items-center justify-center rounded-full border border-line bg-card text-sm text-body hover:text-ink hover:border-line-strong disabled:opacity-60"
      >
        {LOCALE_NAMES[next]}
      </button>
    </div>
  );
}
