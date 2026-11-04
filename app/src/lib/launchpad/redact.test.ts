import { test } from "node:test";
import assert from "node:assert/strict";
import { redactUrls } from "./redact.ts";

test("redactUrls removes every URL, keyed provider paths included, and leaves the rest of the message", () => {
  const msg = "HTTP request failed.\n\nURL: https://arc-mainnet.g.alchemy.com/v2/abc123SECRET\nRequest body: {\"method\":\"eth_getLogs\"}\nDetails: fetch failed";
  const out = redactUrls(msg);
  assert.ok(!out.includes("abc123SECRET"));
  assert.doesNotMatch(out, /\b(?:https?|wss?):\/\/\S+/i);
  assert.match(out, /URL: <url>\nRequest body/);
  assert.match(out, /Details: fetch failed/);
  assert.equal(redactUrls("wss://host/ws?key=k and http://a.b/c"), "<url> and <url>");
  assert.equal(redactUrls("no urls here"), "no urls here");
});

test("redactUrls takes the path after an IPv6 literal host with it", () => {
  assert.equal(
    redactUrls("URL: https://[2001:db8::1]/v2/abc123SECRET\nDetails: fetch failed"),
    "URL: <url>\nDetails: fetch failed",
    "the closing bracket must not leave the keyed path behind",
  );
  assert.equal(redactUrls("ws://[::1]:8545/rpc?key=k"), "<url>");
  assert.equal(redactUrls("see https://a.b/c (docs)"), "see <url> (docs)", "a trailing paren still ends the URL");
});
