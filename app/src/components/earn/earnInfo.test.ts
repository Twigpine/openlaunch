import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import ts from "typescript";
import { loadEarnInfo } from "./earnInfo.ts";

/**
 * The real useEarnInfo source, run with a one-state, one-effect stand-in for React that keeps React's order: an effect
 * re-runs after a render whose deps changed, the previous cleanup first. Enough to see what each render returns.
 */
function hookHarness(load: () => Promise<unknown>) {
  const source = readFileSync(new URL("./earnInfo.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("earnInfo.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let decl = "";
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === "useEarnInfo") decl = n.getText(ast).replace(/^export\s+/, "");
    ts.forEachChild(n, visit);
  };
  visit(ast);
  assert.ok(decl, "earnInfo.ts no longer has useEarnInfo");
  const { outputText } = ts.transpileModule(`(${decl})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } });
  let state: unknown = null;
  let effect: { deps: unknown[]; cleanup?: () => void } | null = null;
  let queued: (() => void | (() => void)) | null = null;
  let queuedDeps: unknown[] = [];
  const useState = (init: unknown) => [state ?? init, (v: unknown) => { state = v; }];
  const useEffect = (fn: () => void | (() => void), deps: unknown[]) => {
    if (!effect || deps.some((d, i) => d !== effect!.deps[i])) {
      queued = fn;
      queuedDeps = deps;
    }
  };
  const hook = new Function("useState", "useEffect", "loadEarnInfo", `return ${outputText}`)(useState, useEffect, load) as (active: boolean) => unknown;
  /** One render, then (like React) its effect commit; returns what the render returned. */
  return (active: boolean) => {
    const out = hook(active);
    if (queued) {
      effect?.cleanup?.();
      const cleanup = queued();
      effect = { deps: queuedDeps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
      queued = null;
    }
    return out;
  };
}

test("a reopened palette shows nothing from its last open until the fresh answer lands", async () => {
  let answer: unknown = { enabled: true, vaults: [] };
  const render = hookHarness(() => Promise.resolve(answer));
  assert.equal(render(true), null); // first open: nothing until the answer
  await Promise.resolve();
  assert.deepEqual(render(true), { enabled: true, vaults: [] });
  assert.equal(render(false), null); // closed
  answer = { enabled: false }; // Earn switched off while the palette was closed
  assert.equal(render(true), null, "the previous open's Earn answer must not show again");
  await Promise.resolve();
  assert.deepEqual(render(true), { enabled: false });
});

// loadEarnInfo is plain fetch logic; the global fetch is swapped for a counter so no request leaves the test.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function serve(answers: (() => Promise<Response>)[]) {
  let calls = 0;
  globalThis.fetch = (async () => {
    const answer = answers[Math.min(calls, answers.length - 1)];
    calls++;
    return answer();
  }) as typeof fetch;
  return () => calls;
}
const json = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("callers asking at the same time share one request", async () => {
  const calls = serve([json({ enabled: true, vaults: [] })]);
  const [a, b] = await Promise.all([loadEarnInfo(), loadEarnInfo()]);
  assert.equal(calls(), 1);
  assert.deepEqual(a, { enabled: true, vaults: [] });
  assert.deepEqual(b, a);
});

test("a settled answer is not remembered: switching EARN off shows on the next ask, without a reload", async () => {
  const calls = serve([json({ enabled: true, vaults: [] }), json({ enabled: false })]);
  assert.deepEqual(await loadEarnInfo(), { enabled: true, vaults: [] });
  assert.deepEqual(await loadEarnInfo(), { enabled: false });
  assert.equal(calls(), 2);
});

test("a failed request reads as off, and the next ask tries again", async () => {
  const calls = serve([async () => new Response("down", { status: 502 }), json({ enabled: true, vaults: [] })]);
  assert.deepEqual(await loadEarnInfo(), { enabled: false });
  assert.deepEqual(await loadEarnInfo(), { enabled: true, vaults: [] });
  assert.equal(calls(), 2);
  serve([async () => { throw new TypeError("network down"); }]);
  assert.deepEqual(await loadEarnInfo(), { enabled: false });
});
