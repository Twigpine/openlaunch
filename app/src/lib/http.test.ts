import assert from "node:assert/strict";
import test from "node:test";
import { concat, encodeAbiParameters, encodeFunctionData, parseAbi, type Hex } from "viem";
import { SIGNED_BODY_MAX, clientIp, readFormData, readJson, readJsonValue, readTextLimited } from "./http.ts";

function streamed(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
}

test("upstream response reads copy reused chunk views and release their reader", async () => {
  const backing = new Uint8Array(1_048_576);
  const view = backing.subarray(8, 9);
  let next = 65;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next > 67) { controller.close(); return; }
      view[0] = next++;
      controller.enqueue(view);
    },
  }, { highWaterMark: 0 });
  const response = new Response(stream);
  assert.deepEqual(await readTextLimited(response, 3), { ok: true, text: "ABC" });
  assert.equal(response.body?.locked, false);
});

test("oversized upstream responses do not wait for underlying cancellation", { timeout: 1_000 }, async () => {
  for (const declared of [false, true]) {
    let pulls = 0, cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(Uint8Array.of(1, 2, 3)); },
      cancel() { cancelled++; return new Promise<void>(() => {}); },
    }, { highWaterMark: 0 });
    const response = new Response(stream, declared ? { headers: { "content-length": "3" } } : {});
    assert.deepEqual(await readTextLimited(response, 2), { ok: false, tooLarge: true });
    assert.equal(pulls, declared ? 0 : 1);
    assert.equal(cancelled, 1);
    assert.equal(response.body?.locked, false);
  }
});

/** Run `fn` as on a Fly Machine (Fly sets FLY_APP_NAME), or off one, restoring the environment after. */
function withFly<T>(on: boolean, fn: () => T): T {
  const before = { app: process.env.FLY_APP_NAME, machine: process.env.FLY_MACHINE_ID };
  if (on) process.env.FLY_APP_NAME = "openlaunch-test";
  else delete process.env.FLY_APP_NAME;
  delete process.env.FLY_MACHINE_ID;
  try {
    return fn();
  } finally {
    if (before.app === undefined) delete process.env.FLY_APP_NAME;
    else process.env.FLY_APP_NAME = before.app;
    if (before.machine === undefined) delete process.env.FLY_MACHINE_ID;
    else process.env.FLY_MACHINE_ID = before.machine;
  }
}

test("off Fly, a client-sent fly-client-ip never picks the bucket", () => {
  withFly(false, () => {
    const spoof = (fly: string) => clientIp(new Request("http://x/", { headers: { "fly-client-ip": fly, "x-forwarded-for": "1.1.1.1, 2.2.2.2" } }));
    assert.equal(spoof("9.9.9.9"), "2.2.2.2", "the proxy-appended hop decides, not the header the client wrote");
    assert.equal(spoof("8.8.8.8"), "2.2.2.2", "so rotating it buys no fresh bucket");
    assert.equal(clientIp(new Request("http://x/", { headers: { "fly-client-ip": "9.9.9.9" } })), "0.0.0.0", "nor does it stand in for a missing chain");
  });
  withFly(true, () => {
    process.env.FLY_MACHINE_ID = "e286";
    delete process.env.FLY_APP_NAME;
    assert.equal(clientIp(new Request("http://x/", { headers: { "fly-client-ip": "3.3.3.3" } })), "3.3.3.3", "FLY_MACHINE_ID alone marks a Fly Machine too");
  });
});

test("clientIp prefers the Fly header, then the proxy-appended last XFF hop", () => withFly(true, () => {
  assert.equal(clientIp(new Request("http://x/")), "0.0.0.0");
  assert.equal(clientIp(new Request("http://x/", { headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" } })), "2.2.2.2");
  assert.equal(
    clientIp(new Request("http://x/", { headers: { "fly-client-ip": "3.3.3.3", "x-forwarded-for": "1.1.1.1, 2.2.2.2" } })),
    "3.3.3.3",
    "the edge header wins over both client-controlled hops",
  );
  assert.equal(clientIp(new Request("http://x/", { headers: { "x-forwarded-for": "9".repeat(200) } })).length, 128, "an absurd header never becomes an absurd map key");
}));

test("clientIp counts trusted hops in from the right, past the entry Fly appends itself", () => withFly(true, () => {
  const before = process.env.TRUSTED_PROXY_HOPS;
  const ip = (xff: string, fly?: string) =>
    clientIp(new Request("http://x/", { headers: { "x-forwarded-for": xff, ...(fly ? { "fly-client-ip": fly } : {}) } }));
  try {
    // client 5.5.5.5 → CDN 2.2.2.2 → Fly, which appends the address assigned to the app (3.3.3.3) as the last entry
    process.env.TRUSTED_PROXY_HOPS = "2";
    assert.equal(ip("5.5.5.5, 3.3.3.3", "2.2.2.2"), "5.5.5.5", "the client, not the CDN in fly-client-ip and not the app's own address");
    assert.equal(ip("1.1.1.1, 2.2.2.2"), "1.1.1.1", "no Fly header: the last entry is the peer a plain proxy appended, so step one in");
    assert.equal(ip("1.1.1.1"), "0.0.0.0", "fewer entries than trusted hops: one shared bucket, never a client entry");
    process.env.TRUSTED_PROXY_HOPS = "0";
    assert.equal(ip("1.1.1.1, 2.2.2.2"), "2.2.2.2", "zero means the single proxy every deployment has");
    assert.equal(ip("1.1.1.1, 2.2.2.2", "3.3.3.3"), "3.3.3.3", "and Fly's peer is then the answer, whatever the chain holds");
    process.env.TRUSTED_PROXY_HOPS = "junk";
    assert.equal(ip("1.1.1.1, 2.2.2.2"), "2.2.2.2", "a junk value falls back to that same single hop");
  } finally {
    if (before === undefined) delete process.env.TRUSTED_PROXY_HOPS;
    else process.env.TRUSTED_PROXY_HOPS = before;
  }
}));

test("readJson caps declared and streamed bodies before parsing", async () => {
  assert.deepEqual(await readJson(new Request("http://x/", { method: "POST", body: JSON.stringify({ a: 1 }) })), { a: 1 });
  assert.equal(await readJson(new Request("http://x/", { method: "POST", headers: { "content-length": "999999" }, body: "{}" })), null);
  assert.equal(await readJson(new Request("http://x/", { method: "POST", body: streamed(["{", "bad"]), duplex: "half" } as RequestInit)), null);
  assert.equal(
    await readJson(new Request("http://x/", { method: "POST", body: streamed(["x".repeat(10)]), duplex: "half" } as RequestInit), 5),
    null,
    "a chunked body is cancelled as soon as it passes the cap",
  );
  assert.equal(await readJson(new Request("http://x/", { method: "POST", body: "[1,2]" })), null, "arrays are not objects");
});

test("readJsonValue accepts the batch array that readJson rejects", async () => {
  assert.deepEqual(await readJsonValue(new Request("http://x/", { method: "POST", body: "[1,2]" })), [1, 2]);
  assert.equal(await readJsonValue(new Request("http://x/", { method: "POST", body: "[1,2]" }), 3), undefined);
  assert.equal(await readJsonValue(new Request("http://x/", { method: "POST", body: "{bad" })), undefined);
});

test("readFormData parses a normal multipart body and refuses an oversized chunked one", async () => {
  const form = new FormData();
  form.set("wallet", "0xabc");
  form.set("file", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "x.png");
  const req = new Request("http://x/", { method: "POST", body: form });
  const parsed = await readFormData(req, 4_096);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.form.get("wallet"), "0xabc");
    assert.equal((parsed.form.get("file") as Blob).size, 3);
  }

  const oversized = new Request("http://x/", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=x" },
    body: streamed(["x".repeat(20)]),
    duplex: "half",
  } as RequestInit);
  assert.deepEqual(await readFormData(oversized, 10), { ok: false, tooLarge: true });
});

test("readTextLimited stops an oversized upstream response", async () => {
  assert.deepEqual(await readTextLimited(new Response("abc"), 3), { ok: true, text: "abc" });
  const declared = await readTextLimited(new Response("abcd"), 3);
  assert.equal(declared.ok, false);
  if (!declared.ok) assert.equal(declared.tooLarge, true);
  const streamedOver = await readTextLimited(new Response(streamed(["a", "b", "c", "d"])), 3);
  assert.equal(streamedOver.ok, false);
  if (!streamedOver.ok) assert.equal(streamedOver.tooLarge, true);
  const broken = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error("boom"));
      },
    }),
  );
  assert.deepEqual(await readTextLimited(broken, 10), { ok: false, tooLarge: false });
});

/**
 * A Coinbase Smart Wallet passkey signature as the server receives it, built from the wallet's ABI layout: a WebAuthn
 * assertion inside its SignatureWrapper, and for a wallet not deployed yet that again inside an ERC-6492 envelope with
 * the factory call that would deploy it. The clientDataJSON carries the extra key Chrome adds.
 */
function smartWalletSignature(deployed: boolean): Hex {
  const word = BigInt("0x" + "ab".repeat(32));
  const clientDataJSON = `{"type":"webauthn.get","challenge":"${"A".repeat(43)}","origin":"https://keys.coinbase.com","crossOrigin":false,` +
    `"other_keys_can_be_added_here":"do not compare clientDataJSON against a template. See the WebAuthn spec 7.2"}`;
  const webauthn = encodeAbiParameters(
    [{ type: "tuple", components: [{ type: "bytes" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }] }],
    [[("0x" + "11".repeat(37)) as Hex, clientDataJSON, 23n, 1n, word, word]],
  );
  const wrapped = encodeAbiParameters([{ type: "tuple", components: [{ type: "uint256" }, { type: "bytes" }] }], [[0n, webauthn]]);
  if (deployed) return wrapped;
  const owner = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [word, word]);
  const deploy = encodeFunctionData({ abi: parseAbi(["function createAccount(bytes[] owners, uint256 nonce)"]), functionName: "createAccount", args: [[owner], 0n] });
  const envelope = encodeAbiParameters([{ type: "address" }, { type: "bytes" }, { type: "bytes" }], ["0x0ba5ed0c6aa8c49038f819e587e2633c4a9f428a", deploy, wrapped]);
  return concat([envelope, ("0x" + "6492".repeat(16)) as Hex]);
}

test("signed bodies from a smart wallet not deployed yet fit SIGNED_BODY_MAX", async () => {
  const wallet = "0x" + "12".repeat(20);
  const signature = smartWalletSignature(false);
  assert.ok(signature.length > smartWalletSignature(true).length, "the ERC-6492 envelope is the larger case");
  const report = JSON.stringify({ postId: 123456, wallet, reason: "other", nonce: "f".repeat(32), ts: Date.now(), signature });
  // POST_MAX is 500 UTF-16 units: 250 emoji is the most bytes a post body can carry
  const post = JSON.stringify({ chain: "base", token: wallet, wallet, parentId: 123456, body: "\u{1F600}".repeat(250), nonce: "f".repeat(32), ts: Date.now(), signature });
  assert.ok(new TextEncoder().encode(report).byteLength > 2_048, "the report body this guards is over the 2 KB cap it replaced");
  for (const body of [report, post]) {
    assert.ok(new TextEncoder().encode(body).byteLength < SIGNED_BODY_MAX / 2, "with room to spare");
    assert.notEqual(await readJson(new Request("http://x/", { method: "POST", body }), SIGNED_BODY_MAX), null);
  }
});
