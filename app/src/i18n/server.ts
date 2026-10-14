import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { createTranslator } from "use-intl/core";
import { isLocale, LOCALE_COOKIE, localeFromAcceptLanguage, type Locale } from "./locales";
import { messagesFor, type Messages } from "./messages";

/** Relative times are computed by the app; dates that are formatted read in UTC everywhere, server and browser alike. */
export const TIME_ZONE = "UTC";

/** This request's language: the switcher's cookie, else the browser's Accept-Language. Read once per request. */
export const getLocale = cache(async (): Promise<Locale> => {
  const chosen = (await cookies()).get(LOCALE_COOKIE)?.value;
  return isLocale(chosen) ? chosen : localeFromAcceptLanguage((await headers()).get("accept-language"));
});

/** A translator for server components, scoped to one area of the messages (`useTranslations` is the client's). */
export async function getTranslations<Namespace extends keyof Messages>(namespace: Namespace) {
  const locale = await getLocale();
  return createTranslator({ locale, messages: messagesFor(locale), namespace, timeZone: TIME_ZONE });
}
