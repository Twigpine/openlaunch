import assert from "node:assert/strict";
import test from "node:test";
import { publicHttpsUrl, METADATA_URL_MAX } from "./public-url.ts";
import { validateMeta } from "./metaShared.ts";
import { validateEdit } from "./editAuth.ts";

const base = { chain: "base" as const, launcher: `0x${"1".repeat(40)}`, salt: `0x${"a".repeat(64)}`, name: "URL policy", symbol: "URL" };
const fields = ["image_url", "banner_url", "website"] as const;

const rejected = [
  "http://example.com/image.webp", "data:image/png;base64,AA==", "javascript:alert(1)", "not a URL",
  "https://user:secret@example.com/image.webp", "https://user@example.com/",
  "https://localhost/", "https://LOCALHOST./", "https://sub.localhost/", "https://localhost.localdomain/",
  "https://printer/", "https://printer.local/", "https://service.internal/", "https://router.lan/", "https://router.home.arpa/",
  "https://0.0.0.0/", "https://10.1.2.3/", "https://127.0.0.1/", "https://169.254.169.254/latest/meta-data/",
  "https://172.16.0.1/", "https://172.31.255.255/", "https://192.168.1.1/", "https://100.64.0.1/", "https://100.127.255.255/",
  "https://198.18.0.1/", "https://192.0.2.1/", "https://198.51.100.1/", "https://203.0.113.1/", "https://224.0.0.1/", "https://255.255.255.255/",
  "https://2130706433/", "https://0x7f000001/", "https://0177.0.0.1/", "https://127.1/", "https://%31%32%37.0.0.1/",
  "https://[::]/", "https://[::1]/", "https://[0:0:0:0:0:0:0:1]/", "https://[fd00::1]/", "https://[fc00::1]/",
  "https://[fe80::1]/", "https://[fec0::1]/", "https://[ff02::1]/", "https://[100::1]/", "https://[2001:db8::1]/", "https://[3fff::1]/",
  "https://[::ffff:127.0.0.1]/", "https://[::ffff:c0a8:101]/", "https://[::ffff:0:7f00:1]/",
  "https://[64:ff9b::7f00:1]/", "https://[64:ff9b:1::808:808]/", "https://[2002:7f00:1::]/",
];

test("metadata rejects local/special literals after URL canonicalization", () => {
  for (const url of rejected) assert.equal(publicHttpsUrl(url), null, url);
});

test("create and edit enforce the same image, banner and website policy", () => {
  for (const field of fields) for (const url of rejected) {
    assert.equal(validateMeta({ ...base, [field]: url }).ok, false, `create ${field}: ${url}`);
    assert.equal(validateEdit({ [field]: url }).ok, false, `edit ${field}: ${url}`);
  }
});

test("public HTTPS hosts, owned image URLs and public literal addresses stay usable", () => {
  for (const url of [
    "https://cdn.example/token.webp", "https://openlaunch.lol/api/images/t/example.webp", "https://x.com/openlaunch",
    "https://8.8.8.8/image.webp", "https://172.15.255.255/", "https://172.32.0.1/", "https://100.63.255.255/", "https://100.128.0.1/",
    "https://[2606:4700:4700::1111]/", "https://[2001:4860:4860::8888]/", "https://[::ffff:8.8.8.8]/",
    "https://[::ffff:0:808:808]/", "https://[64:ff9b::808:808]/", "https://[2002:808:808::1]/",
  ]) {
    const expected = new URL(url).toString();
    assert.equal(publicHttpsUrl(`  ${url}  `), expected);
    for (const field of fields) {
      const create = validateMeta({ ...base, [field]: url });
      const edit = validateEdit({ [field]: url });
      assert.ok(create.ok && edit.ok, `${field}: ${url}`);
      assert.equal(create.value[field], expected);
      assert.equal(edit.value[field], expected);
    }
  }
});

test("complete normalized URLs must fit; no credentials or truncation into another target", () => {
  const prefix = "https://example.com/";
  const exact = prefix + "a".repeat(METADATA_URL_MAX - prefix.length);
  assert.equal(publicHttpsUrl(exact), exact);
  const expanded = prefix + "\u00e9".repeat(100);
  assert.ok(expanded.length < METADATA_URL_MAX);
  assert.equal(publicHttpsUrl(expanded), null, "percent-encoding must also fit the stored field");
  for (const url of [exact + "a", expanded]) for (const field of fields) {
    assert.equal(validateMeta({ ...base, [field]: url }).ok, false);
    assert.equal(validateEdit({ [field]: url }).ok, false);
  }
  for (const bad of [123, {}, ["https://example.com/"]]) assert.equal(publicHttpsUrl(bad), null);
});

test("optional metadata and cleared edit fields preserve their established representations", () => {
  for (const value of [undefined, null, "", "  "]) assert.equal(publicHttpsUrl(value), undefined);
  const create = validateMeta(base);
  const edit = validateEdit({});
  assert.ok(create.ok && edit.ok);
  for (const field of fields) {
    assert.equal(create.value[field], undefined);
    assert.equal(edit.value[field], "");
  }
});
