import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { FILTERS, filterOnChain, type LaunchFilter } from "../../lib/launchpad/search.ts";
import type { ChainKey } from "../../lib/chainKeys.ts";

const source = readFileSync(new URL("./LaunchList.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("LaunchList.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function findExpression(match: (node: ts.Node) => node is ts.Expression): ts.Expression {
  let expression: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (match(node)) expression = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(expression, "the launch controls expose their filter expression");
  return expression;
}

function evaluate(expression: ts.Expression, context: Record<string, unknown>): unknown {
  const { outputText } = ts.transpileModule(`(${expression.getText(ast)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  });
  return runInNewContext(outputText, context);
}

test("the launch chain selector clears incompatible filters when moving to or from Arc", () => {
  const handler = findExpression((node): node is ts.Expression =>
    ts.isArrowFunction(node) && ts.isJsxExpression(node.parent) &&
    ts.isJsxAttribute(node.parent.parent) && node.parent.parent.name.getText(ast) === "onChange" &&
    ts.isJsxSelfClosingElement(node.parent.parent.parent.parent) && node.parent.parent.parent.parent.tagName.getText(ast) === "ChainSelector",
  );
  const cases: { filter: LaunchFilter | null; chain: ChainKey | null; expected: LaunchFilter | null }[] = [
    { filter: "usdg", chain: "arc", expected: null },
    { filter: "gitlawb", chain: "arc", expected: null },
    { filter: "usdc", chain: "arc", expected: "usdc" },
    { filter: "usdc", chain: "base", expected: null },
    { filter: "usdc", chain: "robinhood", expected: null },
    { filter: "usdc", chain: null, expected: "usdc" },
    { filter: "gitlawb", chain: "robinhood", expected: "gitlawb" },
    { filter: "burn", chain: "arc", expected: "burn" },
    { filter: null, chain: "arc", expected: null },
  ];
  for (const entry of cases) {
    let selection: unknown[] = [];
    const onChange = evaluate(handler, {
      FILTERS, filterOnChain, filter: entry.filter, sort: "volume", window_: "24h",
      pick: (...args: unknown[]) => { selection = args; },
    }) as (chain: ChainKey | null) => void;
    onChange(entry.chain);
    assert.deepEqual(selection, ["volume", "24h", entry.chain, entry.expected], `${entry.filter} → ${entry.chain}`);
  }
});

test("the launch filter popup exposes USDC for Arc without exposing unavailable quote assets", () => {
  const filterCall = findExpression((node): node is ts.Expression =>
    ts.isCallExpression(node) && node.expression.getText(ast) === "FILTERS.filter",
  );
  const keys = (chain: ChainKey | null) => (evaluate(filterCall, { FILTERS, filterOnChain, chain }) as typeof FILTERS).map((filter) => filter.key);
  assert.deepEqual(keys("arc"), ["fee0", "burn", "usdc", "today"]);
  assert.deepEqual(keys("base"), ["fee0", "burn", "gitlawb", "today"]);
  assert.deepEqual(keys("robinhood"), ["fee0", "burn", "usdg", "gitlawb", "today"]);
  assert.deepEqual(keys(null), FILTERS.map((filter) => filter.key));
});
