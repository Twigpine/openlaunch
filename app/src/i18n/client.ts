import { createTranslator } from "use-intl/core";
import { DEFAULT_LOCALE, type Locale } from "./locales";
import { en, type Messages } from "./messages/en";

/**
 * The browser's current language, for text built outside React (an error a lib function words, a toast queued from a
 * handler). IntlProvider keeps it in step with the page. Browser-only on purpose: on the server one module is shared
 * by every request, so server code translates with getTranslations and this reads English there.
 */
let current: { locale: Locale; messages: Messages } = { locale: DEFAULT_LOCALE, messages: en };

export function setClientLanguage(locale: Locale, messages: Messages): void {
  if (typeof window !== "undefined") current = { locale, messages };
}

/** A translator for one area of the messages in the reader's language, for code outside a component. */
export function clientTranslator<Namespace extends keyof Messages>(namespace: Namespace) {
  const { locale, messages } = typeof window === "undefined" ? { locale: DEFAULT_LOCALE, messages: en } : current;
  return createTranslator({ locale, messages, namespace, timeZone: "UTC" });
}
