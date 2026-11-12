import assert from "node:assert/strict";
import { after, before, test } from "node:test";

type Route = { path: string; cap: number; post: (req: Request) => Promise<Response> };
let routes: Route[];
let sequence = 0;
const previousFactory = process.env.NEXT_PUBLIC_LAUNCH_FACTORY;
const previousLocker = process.env.NEXT_PUBLIC_LAUNCH_LOCKER;
before(async () => {
  process.env.NEXT_PUBLIC_LAUNCH_FACTORY = "0x1111111111111111111111111111111111111111";
  process.env.NEXT_PUBLIC_LAUNCH_LOCKER = "0x2222222222222222222222222222222222222222";
  const [posts, report, mod, edit, nonce, meta, rpc] = await Promise.all([
    import("./posts/route.ts"), import("./posts/report/route.ts"), import("./posts/mod/route.ts"),
    import("./launch/edit/route.ts"), import("./launch/edit/nonce/route.ts"), import("./launch/meta/route.ts"), import("./rpc/route.ts"),
  ]);
  routes = [
    { path: "posts", cap: 256 * 1024, post: posts.POST }, { path: "posts/report", cap: 256 * 1024, post: report.POST },
    { path: "posts/mod", cap: 256 * 1024, post: mod.POST }, { path: "launch/edit", cap: 256 * 1024, post: edit.POST },
    { path: "launch/edit/nonce", cap: 64 * 1024, post: nonce.POST }, { path: "launch/meta", cap: 64 * 1024, post: meta.POST },
    { path: "rpc", cap: 256 * 1024, post: rpc.POST },
  ];
});
after(() => {
  if (previousFactory === undefined) delete process.env.NEXT_PUBLIC_LAUNCH_FACTORY;
  else process.env.NEXT_PUBLIC_LAUNCH_FACTORY = previousFactory;
  if (previousLocker === undefined) delete process.env.NEXT_PUBLIC_LAUNCH_LOCKER;
  else process.env.NEXT_PUBLIC_LAUNCH_LOCKER = previousLocker;
});

function request(path: string, body: BodyInit, headers: Record<string, string> = {}) {
  return new Request(`http://localhost/api/${path}`, {
    method: "POST", body, duplex: "half", headers: { "content-type": "application/json", "fly-client-ip": `bounded-body-${++sequence}`, ...headers },
  } as RequestInit);
}

function oversized(path: string, length?: string) {
  const state = { pulled: 0, cancelled: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled === 20) { controller.close(); return; }
      state.pulled++;
      controller.enqueue(new Uint8Array(32 * 1024).fill(32));
    },
    cancel() { state.cancelled++; },
  }, { highWaterMark: 0 });
  return { req: request(path, stream, length === undefined ? {} : { "content-length": length }), state };
}

test("JSON write and RPC routes reject finite oversized streams before buffering the remainder", async (t) => {
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("no network expected"); });
  for (const route of routes) {
    for (const declared of [undefined, "1", String(route.cap + 1)]) {
      await t.test(`${route.path}: Content-Length ${declared ?? "absent"}`, async () => {
        const { req, state } = oversized(route.path, declared);
        const response = await route.post(req);
        assert.equal(response.status, 413);
        assert.deepEqual(await response.json(), { error: "body too large" });
        assert.equal(state.cancelled, 1);
        assert.equal(state.pulled, declared === String(route.cap + 1) ? 0 : route.cap / (32 * 1024) + 1);
        assert.equal(req.body?.locked, false);
      });
    }
  }
  assert.equal(network.mock.callCount(), 0);
});

test("bounded JSON routes retain malformed-body errors and small valid JSON reaches field validation", async () => {
  for (const route of routes) {
    const malformed = await route.post(request(route.path, "{broken"));
    assert.equal(malformed.status, 400, route.path);
    assert.deepEqual(await malformed.json(), { error: "bad json" });
    if (route.path !== "rpc") {
      const empty = await route.post(request(route.path, "{}"));
      assert.equal(empty.status, 400, route.path);
      assert.notEqual((await empty.json()).error, "body too large");
    }
  }
});

test("signed routes leave space for smart-wallet signature envelopes without weakening field checks", async () => {
  // Representative encoded envelope size, not a valid signature: field validation must still run.
  const body = JSON.stringify({ signature: `0x${"ab".repeat(64 * 1024)}` });
  for (const route of routes.filter((route) => ["posts", "posts/report", "posts/mod", "launch/edit"].includes(route.path))) {
    const response = await route.post(request(route.path, body));
    assert.equal(response.status, 400, route.path);
    assert.deepEqual(await response.json(), { error: "bad params" });
  }
});

test("RPC preserves ordinary objects and arrays of allowed calls after the bounded read", async (t) => {
  const forwarded: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number } | { id: number }[];
    forwarded.push(body);
    const answer = (call: { id: number }) => ({ jsonrpc: "2.0", id: call.id, result: "0x1" });
    return Response.json(Array.isArray(body) ? body.map(answer) : answer(body));
  });
  const rpc = routes.find((route) => route.path === "rpc")!;
  const single = { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] };
  const batch = [single, { ...single, id: 2, method: "eth_call", params: [{ data: `0x${"ab".repeat(64 * 1024)}` }, "latest"] }];
  for (const body of [single, batch]) {
    const response = await rpc.post(request("rpc", JSON.stringify(body)));
    assert.equal(response.status, 200);
    assert.equal(Array.isArray(await response.json()), Array.isArray(body));
  }
  assert.deepEqual(forwarded, [single, batch]);
});
