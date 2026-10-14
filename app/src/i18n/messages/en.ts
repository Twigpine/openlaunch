import type { Locale } from "../locales";
import common from "./en/common.json";
import header from "./en/header.json";
import wallet from "./en/wallet.json";
import search from "./en/search.json";
import market from "./en/market.json";
import activity from "./en/activity.json";
import hero from "./en/hero.json";
import posts from "./en/posts.json";
import token from "./en/token.json";
import launch from "./en/launch.json";
import info from "./en/info.json";
import account from "./en/account.json";
import bridge from "./en/bridge.json";
import errors from "./en/errors.json";
import footer from "./en/footer.json";

/**
 * English, the source text: it fixes the keys (and their types) and is the fallback for any key a translation leaves
 * out. One JSON file per area of the site. It ships with the client code, so English needs nothing sent per page.
 */
export const en = { common, header, wallet, search, market, activity, hero, posts, token, launch, info, account, bridge, errors, footer };
export type Messages = typeof en;

/** A translation: any subset of the English keys. */
export type Translation = DeepPartial<Messages>;
type DeepPartial<T> = { [K in keyof T]?: T[K] extends string ? string : DeepPartial<T[K]> };

type Tree = { [key: string]: string | Tree };
/** English with every string a translation provides replaced; keys it leaves out keep the English text. */
export function withTranslation(translation: Translation | undefined): Messages {
  if (!translation) return en;
  const overlay = (base: Tree, over: Tree | undefined): Tree => {
    if (!over) return base;
    const out: Tree = {};
    for (const [key, value] of Object.entries(base)) {
      const next = over[key];
      out[key] = typeof value === "string" ? (typeof next === "string" ? next : value) : overlay(value, typeof next === "object" ? next : undefined);
    }
    return out;
  };
  return overlay(en as unknown as Tree, translation as unknown as Tree) as unknown as Messages;
}

declare module "use-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
