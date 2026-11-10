import type { Translation } from "./en";
import common from "./zh-CN/common.json";
import header from "./zh-CN/header.json";
import wallet from "./zh-CN/account-ui.json";
import search from "./zh-CN/search.json";
import market from "./zh-CN/market.json";
import activity from "./zh-CN/activity.json";
import hero from "./zh-CN/hero.json";
import posts from "./zh-CN/posts.json";
import token from "./zh-CN/token.json";
import trade from "./zh-CN/trade.json";
import launch from "./zh-CN/launch.json";
import info from "./zh-CN/info.json";
import account from "./zh-CN/account.json";
import bridge from "./zh-CN/bridge.json";
import errors from "./zh-CN/errors.json";
import earn from "./zh-CN/earn.json";
import footer from "./zh-CN/footer.json";

/** Simplified Chinese. Loaded on the server for Chinese pages and in the browser only when someone switches to it. */
export const zhCN: Translation = { common, header, wallet, search, market, activity, hero, posts, token, trade, launch, info, account, bridge, earn, errors, footer };
