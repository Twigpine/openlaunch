import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { isAddress } from "viem";
import { BPS, DEAD, FEE_PRESETS, MAX_RECIPIENTS } from "../../lib/launchpad/config.ts";
import { bpsToPct, buildRecipients, isBurnAddress } from "../../lib/launchpad/recipients.ts";
import { shortAddr } from "../../lib/chainPublic.ts";

type Element = { type: string; props: Record<string, unknown>; children: unknown[] };
const source = readFileSync(new URL("./LaunchFeeSettings.tsx", import.meta.url), "utf8");
const formSource = readFileSync(new URL("./LaunchForm.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("LaunchFeeSettings.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "LaunchFeeSettings");
assert.ok(declaration);
const { outputText } = ts.transpileModule(`(${declaration.getText(ast).replace(/^export default /, "")})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } });
// Exercise the actual JSX and change handlers without a wallet, browser, or transaction.
// Native arrow-key navigation and layout are verified in the browser separately.
const render = runInNewContext(outputText, {
  React: { createElement: (type: string, props: Record<string, unknown> | null, ...children: unknown[]) => ({ type, props: props ?? {}, children }), Fragment: "fragment" },
  useId: () => "fees", FEE_PRESETS, MAX_RECIPIENTS, isAddress, shortAddr, bpsToPct, isBurnAddress,
  styles: new Proxy({}, { get: (_target, key) => key }),
  ArrowUpRight: "ArrowUpRight", Flame: "Flame", LockKeyhole: "LockKeyhole", Wallet: "Wallet",
}) as (props: Record<string, unknown>) => Element;
const defaults = { feePips: 0, beneficiary: "burn", split: buildRecipients([{ payout: "", pct: "" }]), children: null, onFeeChange: () => {}, onBeneficiaryChange: () => {} };

function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("children" in node)) return [];
  const element = node as Element;
  return [element, ...element.children.flatMap(elements)];
}
function text(node: unknown): string {
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object" || !("children" in node)) return "";
  return (node as Element).children.map(text).join(" ");
}
function change(node: Element, value?: string) {
  (node.props.onChange as (event: { target: { value?: string } }) => void)({ target: { value } });
}

test("fee controls retain the flat launch form section without adding an enclosing card", () => {
  const output = render(defaults);
  assert.equal(output.type, "section");
  assert.equal(output.props.className, "section");
  assert.ok(elements(output).some((node) => node.type === "h2" && node.props.id === output.props["aria-labelledby"]));
  const css = readFileSync(new URL("./LaunchFeeSettings.module.css", import.meta.url), "utf8");
  assert.match(css, /\.section\s*\{\s*padding: 32px 0;/);
  assert.match(css, /\.heading h2\s*\{[^}]*font-size: 16px;/);
});

test("fee choices use the configured pips in one native radio group, with zero preserving its burn reset", () => {
  let pips = -1;
  let beneficiary = "custom";
  const output = render({ ...defaults, feePips: 10_000, onFeeChange: (value: number) => { pips = value; }, onBeneficiaryChange: (value: string) => { beneficiary = value; } });
  const rates = elements(output).filter((node) => node.type === "input" && node.props.name === "fees-rate");
  assert.deepEqual(rates.map((node) => node.props.value), FEE_PRESETS.map((fee) => fee.pips));
  assert.ok(rates.every((node) => node.props.type === "radio"));
  assert.deepEqual(rates.map((node) => node.props.checked), [false, true, false]);
  change(rates[2]);
  assert.equal(pips, 30_000);
  assert.equal(beneficiary, "custom", "Choosing a nonzero fee does not silently replace the recipient");
  change(rates[0]);
  assert.equal(pips, 0);
  assert.equal(beneficiary, "burn");
});

test("zero fee hides recipient controls and keeps permanence, gas, and price-impact disclosures", () => {
  const output = render(defaults);
  assert.equal(elements(output).filter((node) => node.type === "input").length, 3);
  assert.match(text(output), /No fees to distribute/);
  assert.match(text(output), /No trading fees are collected/);
  assert.match(text(output), /Network gas and price impact still apply/);
  assert.match(text(output), /fee rate\s+cannot be changed later/);
  assert.doesNotMatch(text(output), /Claimable by|100% of fees/);
});

test("each routing choice is controlled and never presents an unfinished split as complete", () => {
  for (const value of ["burn", "me", "custom"]) {
    let chosen = "";
    const output = render({ ...defaults, feePips: 10_000, beneficiary: value, onBeneficiaryChange: (next: string) => { chosen = next; } });
    const recipients = elements(output).filter((node) => node.type === "input" && node.props.name === "fees-recipient");
    assert.equal(recipients.length, 3);
    assert.equal(recipients.find((node) => node.props.checked)?.props.value, value);
    change(recipients.find((node) => node.props.value === value)!);
    assert.equal(chosen, value);
    if (value === "custom") {
      assert.match(text(output), /Allocation incomplete/);
      assert.doesNotMatch(text(output), /100% of fees|100% to one destination/);
    } else assert.match(text(output), /100% of fees/);
    assert.match(text(output), /1\s+unit is\s+the trading fee/);
    assert.match(text(output), /0% platform fee/);
  }
  assert.match(text(render({ ...defaults, feePips: 30_000 })), /Burned at collection/);
  assert.match(text(render({ ...defaults, feePips: 30_000 })), /3\s+units are\s+the trading fee/);
});

test("custom allocation renders the parent editor and validation, with honest per-recipient shares", () => {
  const wallet = "0x1111111111111111111111111111111111111111";
  const editor = { type: "div", props: {}, children: ["Split editor"] };
  const invalid = render({ ...defaults, feePips: 10_000, beneficiary: "custom", split: buildRecipients([{ payout: "not-an-address", pct: "100" }]), children: editor });
  assert.ok(elements(invalid).includes(editor));
  assert.match(text(invalid), /Beneficiary 1: enter a valid address/);
  assert.match(text(invalid), /Allocation incomplete/);
  assert.doesNotMatch(text(invalid), /Burned at collection|100% of fees/);
  assert.match(text(render({ ...defaults, feePips: 10_000, beneficiary: "me" })), /Connect your wallet before launch/);
  const split = buildRecipients([{ payout: wallet, pct: "60" }, { payout: DEAD, pct: "40" }]);
  const valid = render({ ...defaults, feePips: 10_000, beneficiary: "custom", split, children: editor });
  assert.match(text(valid), /100% across 2 destinations/);
  assert.match(text(valid), /60\s*% of fees/);
  assert.match(text(valid), /Burn address\s+40\s*% of fees/);
  assert.match(text(valid), /Paid directly to each wallet at collection/);
  assert.doesNotMatch(text(valid), /100% to one destination/);
  assert.ok(text(valid).includes(shortAddr(wallet)));
  for (const beneficiary of ["burn", "me"]) {
    assert.ok(!elements(render({ ...defaults, feePips: 10_000, beneficiary, split, children: editor })).includes(editor));
  }
  assert.ok(!elements(render({ ...defaults, beneficiary: "custom", split, children: editor })).includes(editor));
});

test("fee redesign preserves split validation, editor controls and the exact launch payload", () => {
  assert.match(formSource, /if \(feePips > 0 && beneficiary === "custom"\) errors\.push\(\.\.\.split\.errors\)/);
  assert.match(formSource, /split=\{split\}/);
  assert.match(formSource, /aria-label=\{`beneficiary \$\{i \+ 1\} address`\}/);
  assert.match(formSource, /onChange=\{\(e\) => setRow\(i, \{ pct: e.target.value.trim\(\) \}\)\}/);
  assert.match(formSource, /quickAdd\(DEAD\)/);
  assert.match(formSource, /rows.length >= MAX_RECIPIENTS/);
  assert.match(formSource, /onFeeChange=\{setFeePips\}/);
  assert.match(formSource, /onBeneficiaryChange=\{setBeneficiary\}/);
  const formAst = ts.createSourceFile("LaunchForm.tsx", formSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(formAst) === "recipients" && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(formAst);
  assert.ok(callback);
  const { outputText: recipientCode } = ts.transpileModule(`(${callback.getText(formAst)})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
  const address = "0x1111111111111111111111111111111111111111";
  const split = buildRecipients([{ payout: "0x2222222222222222222222222222222222222222", pct: "60" }, { payout: DEAD, pct: "40" }]);
  const recipients = (feePips: number, beneficiary: string, allocation = split) => JSON.parse(JSON.stringify(runInNewContext(recipientCode, { feePips, beneficiary, address, split: allocation })));
  assert.deepEqual(recipients(0, "me"), []);
  assert.deepEqual(recipients(10_000, "burn"), []);
  assert.deepEqual(recipients(10_000, "me"), [{ payout: address, bps: BPS }]);
  assert.deepEqual(recipients(30_000, "custom"), split.recipients);
  assert.deepEqual(recipients(30_000, "custom", buildRecipients([{ payout: address, pct: "90" }])), [], "An incomplete split must not reach the factory payload");
  assert.match(formSource, /lpFee: feePips,/);
});

test("an unconfigured chain says Coming soon in production and explains the missing contracts in development", () => {
  const formAst = ts.createSourceFile("LaunchForm.tsx", formSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration: ts.VariableDeclaration | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(formAst) === "UNCONFIGURED_CHAIN_COPY") declaration = node;
    ts.forEachChild(node, visit);
  }
  visit(formAst);
  assert.ok(declaration?.initializer);
  const { outputText } = ts.transpileModule(`(${declaration.initializer.getText(formAst)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
  const copy = (NODE_ENV: string) => runInNewContext(outputText, { process: { env: { NODE_ENV } } });
  assert.equal(copy("production"), "Coming soon.");
  assert.equal(copy("development"), "Not configured here. Contract settings are missing in this environment.");
  assert.equal(copy("test"), "Not configured here. Contract settings are missing in this environment.");
  assert.match(formSource, /\{!ok \? UNCONFIGURED_CHAIN_COPY : /, "the chain button renders this copy for an unconfigured chain");
});
