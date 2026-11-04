import assert from "node:assert/strict";
import test from "node:test";
import { clientIp, readFormData, readJson, readJsonValue, readTextLimited } from "./http.ts";

function streamed(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
}

test("clientIp prefers the Fly header, then the proxy-appended last XFF hop", () => {
  assert.equal(clientIp(new Request("http://x/")), "0.0.0.0");
  assert.equal(clientIp(new Request("http://x/", { headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" } })), "2.2.2.2");
  assert.equal(
    clientIp(new Request("http://x/", { headers: { "fly-client-ip": "3.3.3.3", "x-forwarded-for": "1.1.1.1, 2.2.2.2" } })),
    "3.3.3.3",
    "the edge header wins over both client-controlled hops",
  );
  assert.equal(clientIp(new Request("http://x/", { headers: { "x-forwarded-for": "9".repeat(200) } })).length, 128, "an absurd header never becomes an absurd map key");
});

test("clientIp counts trusted hops in from the right, and never falls back to a client-controlled entry", () => {
  const before = process.env.TRUSTED_PROXY_HOPS;
  const ip = (xff: string, fly?: string) =>
    clientIp(new Request("http://x/", { headers: { "x-forwarded-for": xff, ...(fly ? { "fly-client-ip": fly } : {}) } }));
  try {
    process.env.TRUSTED_PROXY_HOPS = "2"; // a CDN appending its own hop in front of Fly's proxy
    assert.equal(ip("1.1.1.1, 2.2.2.2"), "1.1.1.1", "the address the outermost trusted proxy saw, not the proxy's own");
    assert.equal(ip("1.1.1.1, 2.2.2.2", "2.2.2.2"), "1.1.1.1", "with a CDN in front, fly-client-ip is that CDN, so the client comes from the chain");
    assert.equal(ip("1.1.1.1, 9.9.9.9", "2.2.2.2"), "2.2.2.2", "a chain that does not end at the address Fly saw is trusted no further than that address");
    assert.equal(ip("1.1.1.1"), "0.0.0.0", "fewer entries than trusted hops: one shared bucket, never a client entry");
    process.env.TRUSTED_PROXY_HOPS = "0";
    assert.equal(ip("1.1.1.1, 2.2.2.2"), "2.2.2.2", "zero means the single proxy every deployment has");
    assert.equal(ip("1.1.1.1, 2.2.2.2", "2.2.2.2"), "2.2.2.2", "and Fly's own address is then the answer");
    process.env.TRUSTED_PROXY_HOPS = "junk";
    assert.equal(ip("1.1.1.1, 2.2.2.2"), "2.2.2.2", "a junk value falls back to that same single hop");
  } finally {
    if (before === undefined) delete process.env.TRUSTED_PROXY_HOPS;
    else process.env.TRUSTED_PROXY_HOPS = before;
  }
});

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
