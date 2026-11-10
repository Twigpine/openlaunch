/**
 * The site's languages. English is the source text and the fallback: a Chinese message that is missing reads in
 * English rather than as a key. Locale is a cookie the switcher sets, else the browser's Accept-Language; the URL is
 * the same in every language.
 */
export const LOCALES = ["en", "zh-CN"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
/** The cookie the language switcher writes (the name next-intl uses, so a later move to it keeps choices). */
export const LOCALE_COOKIE = "NEXT_LOCALE";
/** Each language named in itself, as the switcher shows it. */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", "zh-CN": "简体中文" };

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * The first language in an Accept-Language header that the site has, by the browser's own order of preference. Any
 * Chinese tag (zh, zh-CN, zh-TW, zh-Hant…) reads Simplified Chinese, the only Chinese the site has; anything unknown
 * reads English.
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale {
  if (!header) return DEFAULT_LOCALE;
  const ranked = header
    .slice(0, 512)
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => /^\s*q=([0-9.]+)\s*$/.exec(p)?.[1]).find(Boolean);
      const quality = q === undefined ? 1 : Number(q);
      return { tag: tag.trim().toLowerCase(), quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .filter((x) => x.tag && x.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const { tag } of ranked) {
    if (tag === "zh" || tag.startsWith("zh-")) return "zh-CN";
    if (tag === "en" || tag.startsWith("en-")) return "en";
  }
  return DEFAULT_LOCALE;
}
