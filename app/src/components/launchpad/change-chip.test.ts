import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { fmtCompact } from "../../lib/launchpad/math.ts";
import { marketChange } from "../../lib/launchpad/market-format.ts";

type ChipProps = { v: number; plain?: boolean; context?: string; className?: string };
type Element = { type: string; props: { className: string; title?: string; children: Element | string } };

// Execute the actual component with an inert JSX runtime and its real pure
// formatters. No React renderer, browser, wallet, or server imports are needed.
const source = readFileSync(new URL("./ChangeChip.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const imports: Record<string, unknown> = {
  "react/jsx-runtime": { jsx: (type: string, props: Element["props"]) => ({ type, props }) },
  "@/lib/launchpad/math": { fmtCompact },
  "@/lib/launchpad/market-format": { marketChange },
};
const exported = {} as { default: (props: ChipProps) => Element };
runInNewContext(compiled, {
  exports: exported,
  require: (id: string) => {
    assert.ok(Object.hasOwn(imports, id), `Unexpected production import: ${id}`);
    return imports[id];
  },
});
const render = exported.default;
const label = (element: Element) => (element.props.children as Element).props.children;

for (const plain of [false, true]) {
  test(`${plain ? "plain" : "pill"} changes render unavailable percentages neutrally, including tooltips`, () => {
    for (const v of [NaN, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE]) {
      const chip = render({ v, plain });
      assert.equal(label(chip), "—", String(v));
      assert.equal(chip.props.title, "— since launch");
      assert.match(chip.props.className, /\btext-muted\b/);
      assert.doesNotMatch(chip.props.className, /(?:text|bg)-(?:up|down)/);
    }
  });

  test(`${plain ? "plain" : "pill"} changes retain valid formatting, direction, context and custom classes`, () => {
    for (const [v, expected, color] of [
      [0.014, "+1.4%", "text-up"],
      [-0.034, "-3.4%", "text-down-ink"],
      [0.12, "+12%", "text-up"],
      [10, "11.0×", "text-up"],
      [18.7, "19.7×", "text-up"],
      [-10, "-1K%", "text-down-ink"],
    ] as const) {
      const chip = render({ v, plain, context: "in 24h", className: "custom-chip" });
      assert.equal(label(chip), expected);
      assert.equal(chip.props.title, `${v * 100}% in 24h`);
      assert.ok(chip.props.className.includes(color));
      assert.ok(chip.props.className.includes("custom-chip"));
    }
    // no move reads neutral in both styles: a green "+0.0%" would say up when nothing moved
    for (const v of [0, -0, 0.0004, -0.0004]) {
      const chip = render({ v, plain });
      assert.equal(label(chip), "0.0%", String(v));
      assert.equal(chip.props.title, `${v * 100}% since launch`);
      assert.match(chip.props.className, /\btext-muted\b/);
      assert.doesNotMatch(chip.props.className, /(?:text|bg)-(?:up|down)/);
    }
  });
}
