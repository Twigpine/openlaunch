"use client";

import { IntlProvider as Provider } from "use-intl";
import type { Locale } from "@/i18n/locales";
import type { Messages } from "@/i18n/messages";

/**
 * The request's language and its messages for client components (`useTranslations` from "use-intl"). The root layout
 * passes them in; the server translates with `getTranslations` from "@/i18n/server".
 */
export default function IntlProvider({ locale, messages, children }: { locale: Locale; messages: Messages; children: React.ReactNode }) {
  return (
    <Provider locale={locale} messages={messages} timeZone="UTC">
      {children}
    </Provider>
  );
}
