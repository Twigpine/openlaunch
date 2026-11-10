import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { zeroAddress } from "viem";
import { createTranslator } from "use-intl/core";
import { en, messagesFor } from "@/i18n/messages";
import { BATCH_FAILED } from "@/lib/earn/calls";
import { depositProblem, withdrawProblem } from "@/lib/earn/math";
import { NOT_CONFIRMED_YET, revertedCopy } from "@/lib/earn/phase";
import { pausedCopy, termsCheck, type LiveTerms } from "@/lib/earn/terms";
import { EARN_VAULTS } from "@/lib/earn/vaults";
import { explainEarn } from "./reasons";

/**
 * Earn in two languages. lib/earn and useEarn give their reasons in English (and the server's terms check sends its
 * reason already worded); EarnPanel shows each known one as a message (earn.reasons) through explainEarn. These keep
 * the two in step: every message stands for a reason the code really gives, and every reason finds its message, reads
 * back exactly in English and reads in Chinese with the values it carried.
 */
const vault = EARN_VAULTS.base!;
const asListed: LiveTerms = { asset: vault.asset, performanceFee: 0n, managementFee: 0n, gates: [zeroAddress, zeroAddress, zeroAddress, zeroAddress] };
const reasonOf = (check: ReturnType<typeof termsCheck>) => (check.ok ? assert.fail("expected a reason") : check.reason);
const gated = [zeroAddress, zeroAddress, zeroAddress, "0x00000000000000000000000000000000000000aa"] as `0x${string}`[];

/** Every reason Earn's code gives, produced by the code itself where it can be called. */
const terms = [
  reasonOf(termsCheck(vault, { ...asListed, asset: "0x0000000000000000000000000000000000000001" })),
  reasonOf(termsCheck(vault, { ...asListed, performanceFee: 100_000_000_000_000_000n })),
  reasonOf(termsCheck(vault, { ...asListed, managementFee: 10_000_000_000_000_000n / 31_536_000n })),
  reasonOf(termsCheck(vault, { ...asListed, gates: gated })),
];
const hook = readFileSync(new URL("./useEarn.ts", import.meta.url), "utf8");
// the hook's own stops and throws, as its source writes them
const hookReasons = [...hook.matchAll(/(?:const (?:ACCOUNT_CHANGED|FLOW_STOPPED) = |throw new Error\()"([^"]+)"/g)].map((m) => m[1]);
const given = [
  depositProblem({ amount: null, balance: 1n }),
  depositProblem({ amount: 1n, balance: undefined }),
  depositProblem({ amount: 2n, balance: 1n }),
  withdrawProblem({ amount: 1n, shares: undefined, position: undefined }),
  withdrawProblem({ amount: 1n, shares: 0n, position: 0n }),
  withdrawProblem({ amount: 2n, shares: 1n, position: 1n }),
  NOT_CONFIRMED_YET,
  BATCH_FAILED,
  revertedCopy("deposit"),
  revertedCopy("withdraw"),
  ...terms,
  ...hookReasons,
].filter((reason): reason is string => typeof reason === "string");

const english = createTranslator({ locale: "en", messages: en, namespace: "earn.reasons", timeZone: "UTC" });
const chinese = createTranslator({ locale: "zh-CN", messages: messagesFor("zh-CN"), namespace: "earn.reasons", timeZone: "UTC" });
type Translate = Parameters<typeof explainEarn>[1];
const inEnglish: Translate = (key, values) => english(key, values);
const inChinese: Translate = (key, values) => chinese(key, values);

test("every Earn reason the panel translates is one the code really gives", () => {
  assert.equal(hookReasons.length, 6, "the hook's account and unmount stops and its four throws");
  const keys = new Set<string>();
  for (const reason of [...given, pausedCopy(terms[3])]) {
    // the outer message is worded last (a paused sentence words its reason first)
    let key = "";
    explainEarn(reason, (k, values) => { key = k; return english(k, values); });
    assert.ok(key, `"${reason}" has a message`);
    keys.add(key);
  }
  assert.deepEqual([...keys].sort(), Object.keys(en.earn.reasons).sort(), "every message is a reason the code gives");
});

test("each reason reads back exactly in English, and in Chinese with the values it carried", () => {
  for (const reason of given) {
    assert.equal(explainEarn(reason, inEnglish), reason);
    const zh = explainEarn(reason, inChinese);
    assert.notEqual(zh, reason, `"${reason}" reads in Chinese`);
    assert.match(zh, /[一-鿿]/);
  }
  assert.equal(explainEarn(terms[0], inChinese), "该金库不再接受 USDC。");
  assert.equal(explainEarn(terms[1], inChinese), "该金库现在会保留其所赚利息的 10%。");
  assert.equal(explainEarn(terms[2], inChinese), "该金库现在收取 1% 的年度管理费。");
  // a wallet's own words, or anything else, read as they came
  assert.equal(explainEarn("User rejected the request.", inChinese), "User rejected the request.");
});

test("a paused deposit reads its reason inside the sentence, in either language", () => {
  for (const reason of terms) {
    const paused = pausedCopy(reason);
    assert.equal(explainEarn(paused, inEnglish), paused);
    const zh = explainEarn(paused, inChinese);
    assert.ok(zh.startsWith("此处已暂停存款："), zh);
    assert.ok(zh.includes(explainEarn(reason, inChinese)), zh);
    assert.ok(zh.endsWith("取款仍然开放。"), zh);
  }
});

test("the panel words every reason it shows through explainEarn", () => {
  const panel = readFileSync(new URL("./EarnPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /\{explain\(p\.note\)\}/);
  assert.match(panel, /: e\.problem \? explain\(e\.problem\)/);
  assert.match(panel, /\{explain\(pausedCopy\(pauseReason\)\)\}/);
  assert.match(panel, /\{explain\(e\.phase\.message\)\}/);
});
