import type { Locale } from "../locales";
import enCommon from "./en/common.json";
import enHeader from "./en/header.json";
import enWallet from "./en/wallet.json";
import enSearch from "./en/search.json";
import enMarket from "./en/market.json";
import enActivity from "./en/activity.json";
import enHero from "./en/hero.json";
import enPosts from "./en/posts.json";
import enFooter from "./en/footer.json";
import zhCommon from "./zh-CN/common.json";
import zhHeader from "./zh-CN/header.json";
import zhWallet from "./zh-CN/wallet.json";
import zhSearch from "./zh-CN/search.json";
import zhMarket from "./zh-CN/market.json";
import zhActivity from "./zh-CN/activity.json";
import zhHero from "./zh-CN/hero.json";
import zhPosts from "./zh-CN/posts.json";
import zhFooter from "./zh-CN/footer.json";

/**
 * Messages by area, one JSON file per area and language, so areas can be translated independently. English is the
 * source and fixes the keys (and their types); a translation may leave a key out, and that key then reads in English.
 */
export const en = {
  common: enCommon,
  header: enHeader,
  wallet: enWallet,
  search: enSearch,
  market: enMarket,
  activity: enActivity,
  hero: enHero,
  posts: enPosts,
  footer: enFooter,
};
export type Messages = typeof en;

type DeepPartial<T> = { [K in keyof T]?: T[K] extends string ? string : DeepPartial<T[K]> };

const translations: Record<Exclude<Locale, "en">, DeepPartial<Messages>> = {
  "zh-CN": {
    common: zhCommon,
    header: zhHeader,
    wallet: zhWallet,
    search: zhSearch,
    market: zhMarket,
    activity: zhActivity,
    hero: zhHero,
    posts: zhPosts,
    footer: zhFooter,
  },
};

type Tree = { [key: string]: string | Tree };

/** `base` with every string `over` translates replaced; keys `over` lacks keep the base text. */
function overlay(base: Tree, over: Tree | undefined): Tree {
  if (!over) return base;
  const out: Tree = {};
  for (const [key, value] of Object.entries(base)) {
    const next = over[key];
    out[key] = typeof value === "string" ? (typeof next === "string" ? next : value) : overlay(value, typeof next === "object" ? next : undefined);
  }
  return out;
}

const cache = new Map<Locale, Messages>();
export function messagesFor(locale: Locale): Messages {
  if (locale === "en") return en;
  let found = cache.get(locale);
  if (!found) {
    found = overlay(en as unknown as Tree, translations[locale] as unknown as Tree) as unknown as Messages;
    cache.set(locale, found);
  }
  return found;
}

/** The raw translation of one locale, for the coverage test. */
export function translationOf(locale: Exclude<Locale, "en">): DeepPartial<Messages> {
  return translations[locale];
}

declare module "use-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
