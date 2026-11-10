import assert from "node:assert/strict";
import test from "node:test";
import { createTranslator } from "use-intl/core";
import { messagesFor } from "../../i18n/messages/index.ts";
import { whyLine } from "../../lib/points/score.ts";
import { whyText, type WhyKey, type WhyValues } from "./why.ts";

/** whyText's `say` over one language's account.points.why messages, as the leaderboard and the cards pass it. */
function sayIn(locale: "en" | "zh-CN") {
  const t = createTranslator({ locale, messages: messagesFor(locale), namespace: "account", timeZone: "UTC" });
  return (key: WhyKey, values: WhyValues) => t(`points.why.${key}`, values);
}

const none = { tokens: 0, verifiedHolders: 0, holders: 0, feesUsd: 0, dumped: 0 };
const noScout = { early: 0, holds: 0, feesUsd: 0 };
// one and many, four-digit counts (written without a separator, as whyLine writes them) and both fee formats
const lines = [
  whyLine("creator", { creatorWhy: { ...none, verifiedHolders: 1, holders: 1, feesUsd: 0.5 }, scoutWhy: noScout }),
  whyLine("creator", { creatorWhy: { ...none, verifiedHolders: 2, holders: 1234, feesUsd: 1234.4 }, scoutWhy: noScout }),
  whyLine("creator", { creatorWhy: { ...none, holders: 7 }, scoutWhy: noScout }),
  whyLine("scout", { creatorWhy: none, scoutWhy: { early: 1, holds: 1, feesUsd: 12.5 } }),
  whyLine("scout", { creatorWhy: none, scoutWhy: { early: 3, holds: 1500, feesUsd: 250 } }),
];

test("the leaderboard's why line reads in English exactly as the server words it", () => {
  assert.deepEqual(lines, [
    "1 verified holder · 1 holder · $0.50 fees from verified traders",
    "2 verified holders · 1234 holders · $1,234 fees from verified traders",
    "7 holders",
    "early on 1 token · 1 held a day+ · $12.50 fees paid",
    "early on 3 tokens · 1500 held a day+ · $250 fees paid",
  ]);
  for (const line of lines) assert.equal(whyText(line, sayIn("en")), line);
});

test("in Chinese every part of the why line is translated, numbers and amounts as written", () => {
  assert.equal(whyText(lines[1], sayIn("zh-CN")), "2 位已验证持有人 · 1234 位持有人 · 来自已验证交易者的 $1,234 手续费");
  assert.equal(whyText(lines[4], sayIn("zh-CN")), "早期买入 3 个代币 · 1500 个代币持有一天以上 · 已支付 $250 手续费");
  for (const line of lines) assert.doesNotMatch(whyText(line, sayIn("zh-CN")), /[A-Za-z]/, line);
});

test("a part the reader does not know reads as it came, and an empty line stays empty", () => {
  assert.equal(whyText("2 holders · something new", sayIn("zh-CN")), "2 位持有人 · something new");
  assert.equal(whyText("", sayIn("zh-CN")), "");
});
