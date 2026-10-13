import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { validateMeta } from "../../lib/launchpad/metaShared.ts";
import { uppercaseInPlace } from "../../lib/launchpad/symbol-input.ts";

const source = readFileSync(new URL("./LaunchForm.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("LaunchForm.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function attribute(name: string): ts.JsxAttribute | undefined {
  let input: ts.JsxSelfClosingElement | undefined;
  function visit(node: ts.Node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "input" && node.attributes.properties.some(
      (prop) => ts.isJsxAttribute(prop) && prop.name.getText(ast) === "id" && prop.initializer && ts.isStringLiteral(prop.initializer) && prop.initializer.text === "symbol",
    )) input = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(input, "Test the real Symbol input");
  return input.attributes.properties.find((prop): prop is ts.JsxAttribute => ts.isJsxAttribute(prop) && prop.name.getText(ast) === name);
}

function handler(name: string, globals: Record<string, unknown> = {}) {
  const value = attribute(name)?.initializer;
  assert.ok(value && ts.isJsxExpression(value) && value.expression, `Symbol needs ${name}`);
  const { outputText } = ts.transpileModule(`(${value.expression.getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  });
  // Execute the actual handler, with inert dependencies. No wallet or RPC calls.
  return runInNewContext(outputText, globals) as (event: unknown) => void;
}

test("Symbol leaves in-progress IME composition text verbatim", () => {
  let stored = "";
  const change = handler("onChange", { setSymbol: (value: string) => { stored = value; } });
  for (const value of ["s", "sk", "sky", "zhong", "中文", "にほん", "日本", "தமிழ்", "ß", "é", "e\u0301", " ab12 ", "ABCDEFGHIJK", ""]) {
    change({ target: { value }, nativeEvent: { isComposing: true } });
    assert.equal(stored, value, `Do not rewrite ${JSON.stringify(value)} during editing`);
  }
  assert.doesNotMatch(attribute("className")!.getText(ast), /\buppercase\b/, "CSS must not change the composition display either");
  assert.equal(attribute("maxLength"), undefined, "Validate the finished value instead of truncating an IME composition or paste");
});

/** A stand-in <input>: value writes and caret moves are recorded like the DOM would apply them. */
function field(value: string, caret = value.length) {
  const el = {
    value,
    selectionStart: caret as number | null,
    selectionEnd: caret as number | null,
    setSelectionRange(start: number, end: number) { el.selectionStart = start; el.selectionEnd = end; },
  };
  return el;
}

test("Symbol uppercases typed and pasted text in the field itself, keeping the caret", () => {
  let stored = "";
  const change = handler("onChange", { setSymbol: (value: string) => { stored = value; }, uppercaseInPlace });
  for (const [value, expected] of [["s", "S"], ["sky9", "SKY9"], [" ab12 ", " AB12 "], ["SKY", "SKY"], ["", ""]] as const) {
    const el = field(value);
    change({ target: el, nativeEvent: { isComposing: false } });
    assert.equal(stored, expected);
    assert.equal(el.value, expected, "the DOM value matches state, so React never rewrites it and never moves the caret");
  }
  const mid = field("SkY", 2);
  change({ target: mid, nativeEvent: { isComposing: false } });
  assert.equal(stored, "SKY");
  assert.deepEqual([mid.selectionStart, mid.selectionEnd], [2, 2], "editing mid-word keeps the caret synchronously");
});

test("Symbol composition works in both browser event orders and the committed value is uppercase", () => {
  let stored = "";
  const bindings = { setSymbol: (value: string) => { stored = value; }, uppercaseInPlace };
  const change = handler("onChange", bindings);
  const end = handler("onCompositionEnd", bindings);

  // Chrome/Firefox: composing input events, compositionend, then a final non-composing input.
  const chrome = field("sk");
  change({ target: chrome, nativeEvent: { isComposing: true } });
  assert.equal(stored, "sk", "composition text is left alone");
  assert.equal(chrome.value, "sk", "the field is not touched mid-composition");
  chrome.value = "sky";
  end({ currentTarget: chrome });
  change({ target: chrome, nativeEvent: { isComposing: false } });
  assert.equal(stored, "SKY");

  // Safari: the last input event still reports isComposing, compositionend follows.
  const safari = field("abc");
  change({ target: safari, nativeEvent: { isComposing: true } });
  assert.equal(stored, "abc");
  end({ currentTarget: safari });
  assert.equal(stored, "ABC");
  assert.equal(safari.value, "ABC");

  // Committed mid-word: caret stays after the committed text.
  const midWord = field("SxKY", 2);
  end({ currentTarget: midWord });
  assert.equal(stored, "SXKY");
  assert.deepEqual([midWord.selectionStart, midWord.selectionEnd], [2, 2]);
  end({ currentTarget: field("中文") });
  assert.equal(stored, "中文");
});

test("typed lowercase symbols pass the launch validation as uppercase", () => {
  let stored = "";
  const change = handler("onChange", { setSymbol: (value: string) => { stored = value; }, uppercaseInPlace });
  const base = { chain: "base" as const, launcher: "0x00000000000000000000000000000000000c0ffe", salt: `0x${"a".repeat(64)}`, name: "Sky" };
  for (const typed of ["sky", "Sky9", "abcdefghij"]) {
    change({ target: field(typed), nativeEvent: { isComposing: false } });
    assert.equal(stored, typed.toUpperCase());
    const result = validateMeta({ ...base, symbol: stored });
    assert.ok(result.ok, typed);
    assert.equal(result.value.symbol, typed.toUpperCase());
  }
  assert.match(source, /import \{ uppercaseInPlace \} from "@\/lib\/launchpad\/symbol-input"/, "the handlers under test use the real helper");
});

test("Enter confirms composition without implicitly submitting the launch form", () => {
  const keyDown = handler("onKeyDown");
  for (const [key, isComposing, keyCode, expected] of [
    ["Enter", true, 13, true],
    ["Enter", false, 229, true], // Some IMEs end composition before keydown.
    ["Enter", false, 13, false],
    ["a", true, 229, false],
  ] as const) {
    let prevented = false;
    keyDown({ key, nativeEvent: { isComposing, keyCode }, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, expected);
  }
});

test("Symbol guidance is associated with the field and the existing launch rules stay intact", () => {
  assert.equal(attribute("aria-describedby")?.initializer?.getText(ast), '"symbol-help"');
  assert.match(source, /id="symbol-help"/);
  assert.match(source, /A.Z.*0.9/);
  assert.match(source, /const symbolClean = symbol\.trim\(\)\.toUpperCase\(\)/);
  assert.match(source, /symbol: symbolClean/);
  // the preview draws the board card and a mini token page from the form; both truncate the ticker, and a blank one reads TICKER
  const preview = readFileSync(new URL("./LaunchPreview.tsx", import.meta.url), "utf8");
  const card = readFileSync(new URL("./LaunchCard.tsx", import.meta.url), "utf8");
  assert.match(preview, /<span className="[^"]*truncate[^"]*">\{row\.symbol\}<\/span>/, "Overlong input must not overflow the token page preview");
  assert.match(card, /<span className="truncate"><span className="font-mono text-body">\{l\.symbol\}<\/span>/, "Overlong input must not overflow the card preview");
  assert.match(readFileSync(new URL("../../lib/launchpad/launch-preview.ts", import.meta.url), "utf8"), /const symbol = p\.symbol \|\| "TICKER";/);
  assert.match(source, /className="break-all">\{symbolClean \|\| "tokens"\}/, "The buy estimate must wrap overlong input too");
  const base = { chain: "base" as const, launcher: "0x00000000000000000000000000000000000c0ffe", salt: `0x${"a".repeat(64)}`, name: "中文" };
  for (const [symbol, valid] of [[" sky9 ", true], ["ABCDEFGHIJ", true], ["ABCDEFGHIJK", false], ["中文", false], ["தமிழ்", false], ["SK Y", false], ["", false]] as const) {
    const result = validateMeta({ ...base, symbol });
    assert.equal(result.ok, valid, symbol);
    if (result.ok) {
      assert.equal(result.value.symbol, symbol.trim().toUpperCase());
      assert.equal(result.value.name, "中文", "Names can still use other languages");
    }
  }
});
