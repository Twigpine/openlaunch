# Languages

The site reads in English or Simplified Chinese (`zh-CN`). English is the source text; Chinese is a translation of it.

This release translates the original public launch, trade, bridge, Earn and account surfaces. The newer community-pair
application/directory pages and Boost dialogs, lanes and rules entry are still in English. Their behavior is preserved
when syncing main; the shared token-page pair disclosures, quote badges, Boost search entry and burn totals are translated.
Admin surfaces, signed messages and API responses also remain in English.

## How a page picks its language

1. The `NEXT_LOCALE` cookie, set by the language switch in the header (`components/LanguageSwitcher.tsx`).
2. Otherwise the browser's `Accept-Language`: any Chinese tag reads Simplified Chinese, anything else English.

The URL is the same in every language. Share cards (`opengraph-image`) stay in English, because crawlers send no
language.

## Adding text

- Messages live in `messages/en/<area>.json` and `messages/zh-CN/<area>.json`, one file per area of the site, registered
  in `messages/en.ts` and `messages/zh-CN.ts`. English fixes the keys and their types: a key used in code that is missing from the English
  file fails `tsc`.
- Client components: `const t = useTranslations("area")` from `use-intl`. Server components:
  `const t = await getTranslations("area")` from `@/i18n/server`.
- Placeholders use ICU syntax: `"{count} holders"`, plurals `"{count, plural, one {# holder} other {# holders}}"`. Markup
  goes through `t.rich("key", { link: (chunks) => <a …>{chunks}</a> })` with `<link>…</link>` in the message.
- Relative times: `useAgo()` (`short` for "3m", `ago` for "3m ago").
- Text worded outside a component (an error a lib function builds, a toast queued in a handler):
  `clientTranslator("area")` from `@/i18n/client`, in the browser only (on the server it reads English).
- A Chinese message may be left out; that key then reads in English. `messages.test.ts` checks that every Chinese key
  exists in English, that placeholders match, and that no message uses an em dash.
- Never translate on-chain or user data: token names, tickers, addresses, chain names (Base, Robinhood Chain, Arc),
  explorer names, numbers and prices.

## Chinese style

- Full-width punctuation in Chinese sentences (，。：？！（）“”), a space between Chinese and Latin text or numbers
  ("在 Base 上发行", "0 平台费"). No em dash (——) here either; use a comma, colon or full stop.
- Plain, direct wording, the same register as the English. Facts as stated in English, never stronger.

| English | 中文 |
| --- | --- |
| Launchpad | 发射台 |
| launch (a token) | 发行（代币） |
| token | 代币 |
| market cap | 市值 |
| volume | 成交量 |
| holders | 持有人 |
| trade / trades | 交易 |
| buy / sell | 买入 / 卖出 |
| price | 价格 |
| liquidity | 流动性 |
| locked liquidity | 锁定的流动性 |
| pool | 资金池 |
| fee / platform fee | 手续费 / 平台费 |
| gas | Gas |
| creator / dev | 创建者 / 开发者 |
| wallet | 钱包 |
| connect wallet | 连接钱包 |
| trending | 热门 |
| new launches | 最新发行 |
| watchlist | 自选 |
| live | 实时 |
| chart | 图表 |
| slippage | 滑点 |
| bridge | 跨链桥 |
| posts (community) | 帖子 |
| activity (trades, live feed) | 动态 |
| Conversation (a token's thread) | 讨论 |
| collect (fees) | 领取 |
| claim (a beneficiary's share) | 提取 |
| beneficiary | 受益人 |
| burn | 销毁 |
| quote asset / priced in | 计价资产 / 以 … 计价 |
| points | 积分 |
| season | 赛季 |
| leaderboard | 排行榜 |
| scout | 发掘者 |
| signature (wallet) | 签名 |
| How it works | 运作方式 |
| agents | 智能体 |
| dashboard / workspace | 面板 / 工作台 |
