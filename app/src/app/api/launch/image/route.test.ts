import assert from "node:assert/strict";
import test from "node:test";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { BANNER_MAX_BYTES, IMAGE_MAX_BYTES, IMAGE_UPLOADS_PER_HOUR } from "@/lib/launchpad/images";
import { POST } from "./route.ts";

const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const garbage = new Uint8Array(32);
const ipLimit = IMAGE_UPLOADS_PER_HOUR * 2;

function request(ip: string, owner: string, bytes: Uint8Array, kind?: string, headers?: HeadersInit): Request {
  const form = new FormData();
  form.set("wallet", owner);
  // Intentionally misleading extension/MIME: the route must validate the actual bytes.
  form.set("file", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "upload.png");
  if (kind) form.set("kind", kind);
  return new Request("http://localhost/api/launch/image", {
    method: "POST", headers: { "x-forwarded-for": ip, ...headers }, body: form,
  });
}

test("image upload route validates images and limits anonymous callers by trusted IP", async (t) => {
  const env = {
    BUCKET_NAME: "image-route-test",
    AWS_ENDPOINT_URL_S3: "https://image-store.invalid",
    AWS_ACCESS_KEY_ID: "test-key",
    AWS_SECRET_ACCESS_KEY: "test-secret",
    IMAGE_PUBLIC_BASE: "https://images.example/api/launch/image",
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  // Exercise the real multipart parser, limiter, decoder and storage command without doing I/O.
  const stored: PutObjectCommand[] = [];
  t.mock.method(S3Client.prototype, "send", async (command: PutObjectCommand) => {
    assert.ok(command instanceof PutObjectCommand);
    stored.push(command);
    return {};
  });
  const png = await sharp({ create: { width: 600, height: 240, channels: 4, background: "#0052ff" } })
    .withMetadata({ exif: { IFD0: { Copyright: "private metadata" } } }).png().toBuffer();

  await t.test("invalid uploads naming another wallet cannot spend that wallet's allowance", async () => {
    for (let i = 0; i < IMAGE_UPLOADS_PER_HOUR; i++) {
      const denied = await POST(request("192.0.2.1", wallet(1), garbage));
      assert.equal(denied.status, 415);
    }
    const response = await POST(request("192.0.2.2", wallet(1), png));
    assert.equal(response.status, 200, "the named wallet can still upload from its own IP");
    assert.match((await response.json()).url, /\/t\/[0-9a-f]{48}\.webp$/);
  });

  await t.test("valid uploads naming another wallet cannot spend that wallet's allowance", async () => {
    for (let i = 0; i < IMAGE_UPLOADS_PER_HOUR; i++) {
      const response = await POST(request("192.0.2.3", wallet(2), png));
      assert.equal(response.status, 200);
    }
    const response = await POST(request("192.0.2.4", wallet(2), png));
    assert.equal(response.status, 200, "valid bytes still do not prove ownership of the wallet field");
  });

  await t.test("rotating wallet fields cannot bypass the existing IP allowance", async () => {
    const before = stored.length;
    for (let i = 0; i < ipLimit; i++) {
      const response = await POST(request("192.0.2.5", wallet(100 + i), i % 2 ? garbage : png));
      assert.equal(response.status, i % 2 ? 415 : 200);
    }
    const denied = await POST(request("192.0.2.5", wallet(999), png));
    assert.equal(denied.status, 429);
    assert.deepEqual(await denied.json(), { error: "slow down" });
    assert.equal(stored.length - before, ipLimit / 2, "invalid and over-budget requests never reach storage");
  });

  await t.test("spoofing forwarded prefixes cannot buy new IP allowances", async () => {
    for (let i = 0; i < ipLimit; i++) {
      const response = await POST(request(`198.51.100.${i}, 192.0.2.6`, wallet(200 + i), garbage));
      assert.equal(response.status, 415);
    }
    const denied = await POST(request("198.51.100.254, 192.0.2.6", wallet(998), png));
    assert.equal(denied.status, 429);
    assert.deepEqual(await denied.json(), { error: "slow down" });
  });

  await t.test("Fly's client IP takes precedence over forwarded values", async (t) => {
    const previous = process.env.FLY_APP_NAME;
    process.env.FLY_APP_NAME = "image-route-test";
    t.after(() => { if (previous === undefined) delete process.env.FLY_APP_NAME; else process.env.FLY_APP_NAME = previous; });
    for (let i = 0; i < ipLimit; i++) {
      const response = await POST(request(`198.51.100.${i}`, wallet(300 + i), garbage, undefined, { "fly-client-ip": "192.0.2.7" }));
      assert.equal(response.status, 415);
    }
    assert.equal((await POST(request("198.51.100.254", wallet(997), png, undefined, { "fly-client-ip": "192.0.2.7" }))).status, 429);
  });

  await t.test("wallet shape, format, decoder and size failures retain their responses", async () => {
    const before = stored.length;
    const disguised = new Uint8Array(32);
    disguised.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const tiny = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#0052ff" } }).png().toBuffer();
    for (const [req, status, error] of [
      [request("192.0.2.8", "not-a-wallet", png), 400, "connect a wallet first"],
      [request("192.0.2.8", wallet(3), garbage), 415, "PNG, JPEG, WebP or GIF only"],
      [request("192.0.2.8", wallet(3), disguised), 415, "not a valid image"],
      [request("192.0.2.8", wallet(3), tiny), 415, "image too small (min 16×16)"],
      [request("192.0.2.8", wallet(3), new Uint8Array(IMAGE_MAX_BYTES + 1)), 413, "image must be ≤ 2 MB"],
      [request("192.0.2.8", wallet(3), new Uint8Array(BANNER_MAX_BYTES + 1), "banner"), 413, "image must be ≤ 4 MB"],
      [request("192.0.2.8", wallet(3), png, undefined, { "content-length": String(BANNER_MAX_BYTES + 16 * 1024 + 1) }), 413, "image must be ≤ 4 MB"],
    ] as const) {
      const response = await POST(req);
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error });
    }
    assert.equal(stored.length, before, "rejected requests are never stored");
  });

  await t.test("logos and banners still store stripped WebP bytes with random keys", async () => {
    const keys: string[] = [];
    for (const [kind, width, height] of [[undefined, 512, 512], ["banner", 1500, 500]] as const) {
      const response = await POST(request("192.0.2.9", wallet(4), png, kind));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.json();
      const command = stored.at(-1)!;
      assert.match(command.input.Key!, /^t\/[0-9a-f]{48}\.webp$/);
      keys.push(command.input.Key!);
      assert.equal(body.url, `${env.IMAGE_PUBLIC_BASE}/${command.input.Key}`);
      assert.equal(command.input.ContentType, "image/webp");
      const output = command.input.Body as Buffer;
      assert.equal(body.bytes, output.length);
      const metadata = await sharp(output).metadata();
      assert.equal(metadata.format, "webp");
      assert.equal(metadata.width, width);
      assert.equal(metadata.height, height);
      assert.equal(metadata.exif, undefined);
      assert.equal(output.includes("private metadata"), false);
    }
    assert.notEqual(keys[0], keys[1]);
  });

  for (const declared of [undefined, "10"]) {
    await t.test(`stops reading oversized multipart streams with ${declared === undefined ? "no" : "an understated"} size header`, async () => {
      const before = stored.length;
      const chunk = new Uint8Array(64 * 1024);
      const availableChunks = 80;
      let chunksRead = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunksRead === availableChunks) controller.close();
          else { chunksRead++; controller.enqueue(chunk); }
        },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 });
      const req = new Request("http://localhost/api/launch/image", {
        method: "POST", body, duplex: "half",
        headers: { "content-type": "multipart/form-data; boundary=test", "x-forwarded-for": "192.0.2.10", ...(declared === undefined ? {} : { "content-length": declared }) },
      } as RequestInit & { duplex: "half" });
      const response = await POST(req);
      assert.equal(response.status, 413, `read ${chunksRead}/${availableChunks} chunks; cancelled=${cancelled}`);
      assert.deepEqual(await response.json(), { error: "image must be ≤ 4 MB" });
      assert.equal(chunksRead, Math.floor((BANNER_MAX_BYTES + 16 * 1024) / chunk.length) + 1);
      assert.ok(chunksRead < availableChunks, "the parser must not drain the rest of the request");
      assert.equal(cancelled, true);
      assert.equal(body.locked, false);
      assert.equal(stored.length, before);
    });
  }
});
