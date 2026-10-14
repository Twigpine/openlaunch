import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTranslator } from "use-intl/core";
import { en, messagesFor } from "../../i18n/messages/index.ts";
import { reasonOf } from "./reasons.ts";

/**
 * The profile sheet in two languages. Validation, the profile API, friendlyError and the sheet's own fallbacks give
 * their failure reasons in English; the sheet shows each known one as a message (account.profileSheet.errors). These
 * keep the two in step: every message stands for a reason the code really gives, every reason finds its message with
 * its values, and the English message reads exactly as the reason did.
 */
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const sheet = read("./ProfileSheet.tsx");
const reasons = en.account.profileSheet.errors;
// the reasons as the code writes them: the libs' and the API's own strings, and the fallbacks the sheet throws with
const given = [
  ...[
    "../../lib/profiles/validate.ts",
    "../../lib/launchpad/xHandle.ts",
    "../../lib/profiles/server.ts",
    "../../lib/profiles/xpost.ts",
    "../../lib/errors.ts",
    "../../app/api/profile/route.ts",
    "../../app/api/profile/check/route.ts",
    "../../app/api/profile/delete/route.ts",
    "../../app/api/profile/x/route.ts",
  ].map(read),
  ...[...sheet.matchAll(/d\.error \?\? ("[^"]+")/g)].map((m) => m[1]),
].join("\n");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// sample values for the reasons that carry one
const sample: Record<string, string> = { chain: "Robinhood Chain", handle: "alice_1", expected: "bob", code: "OL-ABCDEFGH" };
const fill = (message: string) => message.replace(/\{(\w+)\}/g, (_, name: string) => sample[name]);

test("every failure reason the profile sheet translates is one the code really gives", () => {
  for (const [key, english] of Object.entries(reasons)) {
    // a placeholder stands for a template expression: "the code {code} is not in that post" is `the code ${…} is not…`
    const pattern = english.split(/\{\w+\}/).map(escape).join("\\$\\{[^}]+\\}");
    assert.match(given, new RegExp(`["\`]${pattern}["\`]`), `profileSheet.errors.${key} ("${english}") is not a reason the code gives`);
  }
});

test("each reason finds its own message and values, and reads back exactly in English", () => {
  const t = createTranslator({ locale: "en", messages: en, namespace: "account.profileSheet.errors", timeZone: "UTC" });
  for (const [key, english] of Object.entries(reasons)) {
    const reason = fill(english);
    const found = reasonOf(reason);
    assert.ok(found, reason);
    assert.equal(found.key, key, reason);
    assert.equal(t(found.key, found.values), reason);
  }
  // a wallet's own words, or anything else, read as they came
  assert.equal(reasonOf("User rejected the request."), null);
  assert.equal(reasonOf("username: something new"), null);
});

test("in Chinese the reasons read in Chinese, with the values the reason carried", () => {
  const t = createTranslator({ locale: "zh-CN", messages: messagesFor("zh-CN"), namespace: "account.profileSheet.errors", timeZone: "UTC" });
  const say = (reason: string) => {
    const found = reasonOf(reason);
    return found ? t(found.key, found.values) : reason;
  };
  assert.equal(say("username: reserved"), "用户名：已被保留");
  assert.equal(say("your wallet lives on Robinhood Chain: switch your wallet to Robinhood Chain and sign again"), "你的钱包在 Robinhood Chain 上：请将钱包切换到 Robinhood Chain 后重新签名");
  assert.equal(say("that post is from @alice, but this code is for @bob"), "该帖子来自 @alice，但这个验证码属于 @bob");
  assert.equal(say("the code OL-ABCDEFGH is not in that post"), "该帖子中没有验证码 OL-ABCDEFGH");
});

test("the sheet shows every reason through its message, and signs the same words in any language", () => {
  assert.match(sheet, /const r = reasonOf\(text\);\s*return r \? t\(r\.key, r\.values\) : text;/);
  assert.match(sheet, /<Reason text=\{v\.error\} \/>/);
  assert.match(sheet, /nameState\.error === undefined \? t\("taken"\) : <Reason text=\{nameState\.error\} \/>/);
  assert.equal(sheet.match(/role="alert"><Reason text=\{err\} \/><\/p>/g)?.length, 2);
  // the signed messages and the X post text are the code's own, never a translation
  assert.match(sheet, /wallet\.signMessage\(\{ message: buildProfileMessage\(\{ wallet: address, nonce: n, ts, fields: v\.value \}\) \}\)/);
  assert.match(sheet, /wallet\.signMessage\(\{ message: buildProfileDeleteMessage\(\{ wallet: address, nonce: n, ts \}\) \}\)/);
  assert.match(sheet, /<pre className="[^"]*">\{code\.text\}<\/pre>/);
  assert.match(sheet, /onClick=\{\(\) => void copy\(code\.text\)\}/);
  assert.doesNotMatch(read("../../lib/profiles/auth.ts") + read("../../lib/profiles/xpost.ts"), /i18n|use-intl|Translator/);
});
