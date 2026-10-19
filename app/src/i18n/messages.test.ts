import assert from "node:assert/strict";
import { test } from "node:test";
import { en, messagesFor, translationOf } from "./messages/index.ts";
import { DEFAULT_LOCALE, isLocale, localeFromAcceptLanguage } from "./locales.ts";
import { SITE_DESCRIPTION, SITE_TITLE } from "../lib/brand.ts";

type Tree = { [key: string]: string | Tree };
function leaves(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else for (const [p, v] of leaves(value, path)) out.set(p, v);
  }
  return out;
}
/** The ICU arguments and tags a message uses: "{count}", "{count, plural, …}", "<link>". */
function placeholders(message: string): string[] {
  const names = new Set<string>();
  for (const m of message.matchAll(/\{\s*([A-Za-z0-9_]+)\s*[,}]/g)) names.add(`{${m[1]}}`);
  for (const m of message.matchAll(/<([A-Za-z0-9_]+)>/g)) names.add(`<${m[1]}>`);
  return [...names].sort();
}

const english = leaves(en as unknown as Tree);
const chinese = leaves(translationOf("zh-CN") as unknown as Tree);

test("every Chinese message translates an English one, with the same placeholders and tags", () => {
  for (const [key, message] of chinese) {
    assert.ok(english.has(key), `zh-CN has a key English does not: ${key}`);
    assert.deepEqual(placeholders(message), placeholders(english.get(key)!), `placeholders differ for ${key}`);
    assert.ok(message.trim().length > 0, `empty translation: ${key}`);
  }
});

test("the areas this release translates are complete in Chinese", () => {
  const missing = [...english.keys()].filter((key) => !chinese.has(key));
  assert.deepEqual(missing, [], `untranslated: ${missing.join(", ")}`);
});

test("no message uses an em dash, in either language", () => {
  for (const [key, message] of [...english, ...chinese]) assert.equal(/—/.test(message), false, `em dash in ${key}`);
});

test("a missing Chinese message reads in English, and English is the source itself", () => {
  assert.equal(messagesFor("en"), en);
  const zh = leaves(messagesFor("zh-CN") as unknown as Tree);
  assert.deepEqual([...zh.keys()].sort(), [...english.keys()].sort());
  for (const [key, value] of zh) assert.equal(value, chinese.get(key) ?? english.get(key));
});

test("the English tab title and description are the site's own, so the two never drift", () => {
  assert.equal(en.common.site.title, SITE_TITLE);
  assert.equal(en.common.site.description, SITE_DESCRIPTION);
});

test("the browser's language picks Simplified Chinese for any Chinese tag, English otherwise", () => {
  assert.equal(localeFromAcceptLanguage(null), DEFAULT_LOCALE);
  assert.equal(localeFromAcceptLanguage("zh-CN,zh;q=0.9,en;q=0.8"), "zh-CN");
  assert.equal(localeFromAcceptLanguage("zh-TW"), "zh-CN");
  assert.equal(localeFromAcceptLanguage("zh-Hant-HK"), "zh-CN");
  assert.equal(localeFromAcceptLanguage("en-US,en;q=0.9"), "en");
  // the browser's order of preference decides, not the order the tags are written in
  assert.equal(localeFromAcceptLanguage("en;q=0.5, zh;q=0.9"), "zh-CN");
  assert.equal(localeFromAcceptLanguage("fr-FR, zh;q=0.8"), "zh-CN");
  assert.equal(localeFromAcceptLanguage("fr-FR, de"), "en");
  assert.equal(localeFromAcceptLanguage("zh;q=0, en"), "en");
  assert.equal(localeFromAcceptLanguage("*"), "en");
  assert.equal(isLocale("zh-CN"), true);
  assert.equal(isLocale("zh"), false);
});
