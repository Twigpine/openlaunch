"use client";

import { createContext, useCallback, useContext, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IntlProvider as Provider } from "use-intl";
import { LOCALE_COOKIE, type Locale } from "@/i18n/locales";
import { withTranslation, type Translation } from "@/i18n/messages/en";
import { setClientLanguage } from "@/i18n/client";

type Switch = { switchLocale: (next: Locale) => void; pending: boolean };
const SwitchContext = createContext<Switch | null>(null);

/**
 * The request's language for client components (`useTranslations` from "use-intl"); the server translates with
 * `getTranslations` from "@/i18n/server". English ships with the client code, so the layout sends only a translation
 * (Chinese pages), never the English text again.
 *
 * Switching does not wait for the server: client components re-render in the new language at once (Chinese is one
 * chunk, loaded the first time someone switches to it), then a background refresh brings the server-rendered parts
 * (the footer, page headings) into the same language.
 */
export default function IntlProvider({ locale, translation, children }: { locale: Locale; translation?: Translation; children: React.ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [active, setActive] = useState<{ locale: Locale; translation?: Translation }>({ locale, translation });
  // a new locale from the server (a refresh, or another tab's choice on reload) replaces the local one
  const [fromServer, setFromServer] = useState(locale);
  if (fromServer !== locale) {
    setFromServer(locale);
    setActive({ locale, translation });
  }
  const messages = useMemo(() => withTranslation(active.translation), [active.translation]);
  setClientLanguage(active.locale, messages);

  const switchLocale = useCallback((next: Locale) => {
    const secure = window.location.protocol === "https:" ? "; secure" : "";
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax${secure}`;
    document.documentElement.lang = next;
    const load = next === "en" ? Promise.resolve(undefined) : import("@/i18n/messages/zh-CN").then((m) => m.zhCN);
    void load.then((t) => {
      setActive({ locale: next, translation: t });
      startTransition(() => router.refresh());
    });
  }, [router]);

  return (
    <SwitchContext.Provider value={{ switchLocale, pending }}>
      <Provider locale={active.locale} messages={messages} timeZone="UTC">
        {children}
      </Provider>
    </SwitchContext.Provider>
  );
}

/** The language switch: changes the page's language now, and the server-rendered parts as soon as they arrive. */
export function useSwitchLocale(): Switch {
  const value = useContext(SwitchContext);
  if (!value) throw new Error("useSwitchLocale needs IntlProvider");
  return value;
}
