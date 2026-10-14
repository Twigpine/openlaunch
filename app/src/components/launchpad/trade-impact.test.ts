import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { impactLevel, priceImpact } from "../../lib/launchpad/price-impact.ts";
import { poolKeyForLaunch } from "../../lib/launchpad/suites.ts";

const source = readFileSync(new URL("./TradePanel.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("TradePanel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const calls: ts.CallExpression[] = [];
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "priceImpact") calls.push(node);
  ts.forEachChild(node, visit);
}
visit(ast);

const launch = {
  suite_id: "quote-v2", lp_fee: 30_000, creator_fee_pips: 30_000, pool_fee_pips: 0,
  quote: "0x0000000000000000000000000000000000000000", token: "0x000000000000000000000000000000000000ffff",
  hook_address: "0x00000000000000000000000000000000000020cc",
};

for (const side of ["buy", "sell"]) {
  test(`quote-only ${side} and sell-all exclude the creator fee from impact without changing the pool`, () => {
    assert.equal(calls.length, 2, "cover the normal quote and the sell-all estimate");
    const poolKey = poolKeyForLaunch(launch);
    assert.equal(poolKey.fee, 0);
    for (const call of calls) {
      const { outputText } = ts.transpileModule(call.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
      const impact = runInNewContext(outputText, {
        priceImpact, poolKey, tradingFeePips: 30_000, side, sqrtPriceX96: 2n ** 96n,
        tokenBalance: 1_000_000n, amountIn: 1_000_000n, result: [843_900n],
        fresh: { sqrtPriceX96: 2n ** 96n, out: 843_900n },
      });
      assert.ok(Math.abs(impact - 0.13) < 1e-12, `${side}: ${impact}`);
      assert.equal(impactLevel(impact), "warn", "13% does not require the 15% extra confirmation");
    }
    assert.equal(poolKey.fee, 0);
  });
}

test("the token page supplies the creator fee, including zero and legacy records", () => {
  const page = readFileSync(new URL("../../app/t/[chain]/[token]/page.tsx", import.meta.url), "utf8");
  const pageAst = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let fee: ts.Expression | undefined;
  function find(node: ts.Node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(pageAst) === "TradePanel") {
      for (const prop of node.attributes.properties) {
        if (ts.isJsxAttribute(prop) && prop.name.getText(pageAst) === "tradingFeePips" && prop.initializer && ts.isJsxExpression(prop.initializer)) fee = prop.initializer.expression;
      }
    }
    ts.forEachChild(node, find);
  }
  find(pageAst);
  assert.ok(fee, "TradePanel needs a trading fee separate from the pool key");
  const { outputText } = ts.transpileModule(fee.getText(pageAst), { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
  for (const [l, expected] of [[launch, 30_000], [{ ...launch, creator_fee_pips: 0 }, 0], [{ lp_fee: 10_000 }, 10_000]] as const) {
    assert.equal(runInNewContext(outputText, { l }), expected);
  }
});
