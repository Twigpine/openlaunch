import type { Locale } from "../locales";
import { en, withTranslation, type Messages, type Translation } from "./en";
import { zhCN } from "./zh-CN";

/**
 * Messages by area, one JSON file per area and language (en.ts, zh-CN.ts), so areas can be translated independently.
 * English is the source and fixes the keys (and their types); a translation may leave a key out, and that key then
 * reads in English.
 */
export { en, withTranslation };
export type { Messages, Translation };

const translations: Record<Exclude<Locale, "en">, Translation> = { "zh-CN": zhCN };

/** The translation a page in `locale` sends to the browser (English is already in the client code). */
export function translationOf(locale: Exclude<Locale, "en">): Translation {
  return translations[locale];
}

const cache = new Map<Locale, Messages>();
/** Every message in `locale`, English where the translation has no text. */
export function messagesFor(locale: Locale): Messages {
  if (locale === "en") return en;
  let found = cache.get(locale);
  if (!found) {
    found = withTranslation(translations[locale]);
    cache.set(locale, found);
  }
  return found;
}
