import assert from "node:assert/strict";
import { test } from "node:test";
import { sameOriginRequest } from "./same-origin.ts";

// The standalone server builds route URLs from its bind address, never the public host.
const request = (headers: Record<string, string>) =>
  new Request("http://0.0.0.0:3000/api/solana/rpc", { method: "POST", headers });

test("a browser call from the site passes although the route URL is the bind address", () => {
  assert.equal(
    sameOriginRequest(request({ origin: "https://openlaunch.lol", host: "openlaunch.lol" })),
    true,
  );
  assert.equal(
    sameOriginRequest(
      request({
        origin: "https://openlaunch.lol",
        host: "0.0.0.0:3000",
        "x-forwarded-host": "openlaunch.lol",
      }),
    ),
    true,
  );
  assert.equal(
    sameOriginRequest(request({ origin: "http://localhost:3000", host: "localhost:3000" })),
    true,
  );
  assert.equal(
    sameOriginRequest(request({ origin: "https://OpenLaunch.lol", host: "openlaunch.lol" })),
    true,
  );
});

test("other sites, opaque origins and ports are refused", () => {
  assert.equal(
    sameOriginRequest(request({ origin: "https://evil.example", host: "openlaunch.lol" })),
    false,
  );
  assert.equal(
    sameOriginRequest(request({ origin: "https://openlaunch.lol.evil.example", host: "openlaunch.lol" })),
    false,
  );
  assert.equal(sameOriginRequest(request({ origin: "null", host: "openlaunch.lol" })), false);
  assert.equal(
    sameOriginRequest(request({ origin: "https://openlaunch.lol:8443", host: "openlaunch.lol" })),
    false,
  );
  assert.equal(sameOriginRequest(request({ origin: "https://openlaunch.lol" })), false);
});

test("a request without Origin passes unless the browser marks it cross-site", () => {
  assert.equal(sameOriginRequest(request({ host: "openlaunch.lol" })), true);
  assert.equal(
    sameOriginRequest(request({ host: "openlaunch.lol", "sec-fetch-site": "cross-site" })),
    false,
  );
});
