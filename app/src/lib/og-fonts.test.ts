import assert from "node:assert/strict";
import { test } from "node:test";
import { cjkCharacters } from "./ogFonts.ts";

test("a share card fetches a CJK face only for the CJK characters it draws, each once, by the face that has them", () => {
  // Latin names need nothing beyond Geist
  assert.deepEqual(cjkCharacters("PEPE / pepe 123 $1.2K"), { han: "", hangul: "" });
  assert.deepEqual(cjkCharacters("币安人生 BNB"), { han: "币安人生", hangul: "" });
  assert.deepEqual(cjkCharacters("狗狗币 狗"), { han: "狗币", hangul: "" });
  // kana and full-width punctuation are in Noto Sans SC; Hangul needs Noto Sans KR
  assert.deepEqual(cjkCharacters("ねこ 한국 （中）"), { han: "ねこ（中）", hangul: "한국" });
  // characters outside the basic plane count as one character
  assert.deepEqual(cjkCharacters("𠀋a"), { han: "𠀋", hangul: "" });
});

test("the subset request stays bounded however long the text is", () => {
  const many = Array.from({ length: 400 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("");
  assert.equal([...cjkCharacters(many).han].length, 300);
});
