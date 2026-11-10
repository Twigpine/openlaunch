import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { en } from "../../i18n/messages/index.ts";

type PreviewInput = { value: string; compact?: boolean };

/**
 * Render the real client component and React's attribute serializer, inside use-intl's provider with the messages of
 * `locale` (English by default). The main test command selects react-server exports, so this child deliberately starts
 * without that condition: useState/useRef and react-dom/server need the normal React entry points. Static rendering
 * performs no image requests or uploads.
 */
function renderPreviews(inputs: PreviewInput[], locale = "en"): string[] {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--eval", `
    const { readFileSync } = require("node:fs");
    const { createElement } = require("react");
    const { renderToStaticMarkup } = require("react-dom/server");
    const { IntlProvider } = require("use-intl");
    const { messagesFor } = require("./src/i18n/messages/index.ts");
    const ImageUpload = require("./src/components/launchpad/ImageUpload.tsx").default;
    const { inputs, locale } = JSON.parse(readFileSync(0, "utf8"));
    const output = inputs.map((props) => renderToStaticMarkup(createElement(IntlProvider, { locale, messages: messagesFor(locale), timeZone: "UTC" }, createElement(ImageUpload, {
      ...props, wallet: undefined, onChange() { throw new Error("Rendering must not upload or change the URL"); },
    }))));
    process.stdout.write(JSON.stringify(output));
  `], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    input: JSON.stringify({ inputs, locale }),
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as string[];
}

test("image previews retain HTTP(S), trim whitespace, and preserve compact sizing", () => {
  const [https, http, compact] = renderPreviews([
    { value: "  https://images.example/logo.png  " },
    { value: "http://images.example/logo.gif" },
    { value: "https://images.example/logo.webp", compact: true },
  ]);
  assert.ok(https.includes('<img src="https://images.example/logo.png"'));
  assert.ok(http.includes('<img src="http://images.example/logo.gif"'));
  assert.ok(compact.includes('<img src="https://images.example/logo.webp"'));
  assert.ok(https.includes('width="88" height="88"'));
  assert.ok(compact.includes('width="64" height="64"'));
  for (const html of [https, http, compact]) {
    assert.ok(html.includes('referrerPolicy="no-referrer"'));
    assert.ok(html.includes(">Change image</p>"));
  }
});

test("non-HTTP(S) input never becomes an image preview", () => {
  const values = [
    "", "  ",
    "javascript:alert(1)", " \tjavascript:alert(1)\n",
    "JaVaScRiPt:alert(1)", "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "data:image/svg+xml,<svg onload=alert(1)></svg>",
    "//images.example/logo.png", "/logo.png", "https:images.example/logo.png",
    '"/><img src=x onerror="alert(1)">',
  ];
  const output = renderPreviews(values.map((value) => ({ value })));
  for (const [index, html] of output.entries()) {
    assert.equal(html.includes("<img"), false, `Unexpected preview for ${JSON.stringify(values[index])}`);
    assert.equal(html.includes("<script"), false);
    assert.ok(html.includes(">Upload image</p>"));
  }
});

test("quotes and markup in an HTTP(S) URL remain encoded attribute data", () => {
  const value = 'https://images.example/logo.png?x=" onerror="alert(1)"><script>alert(2)</script>&y=\'test\'';
  const escaped = "https://images.example/logo.png?x=&quot; onerror=&quot;alert(1)&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;&amp;y=&#x27;test&#x27;";
  // the preview loads the parsed URL, as the browser would request it: quotes, angle brackets and spaces percent-encoded
  const parsed = "https://images.example/logo.png?x=%22%20onerror=%22alert(1)%22%3E%3Cscript%3Ealert(2)%3C/script%3E&amp;y=%27test%27";
  const [html] = renderPreviews([{ value }]);
  // Assert the actual serialized sink, not a duplicate sanitization function or
  // a source-code pattern. The whole value stays in one src attribute; the field keeps what was typed.
  assert.ok(html.includes(`<img src="${parsed}" alt=""`));
  assert.ok(html.includes(`value="${escaped}"`));
  assert.equal(html.includes(' onerror="'), false);
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("</script>"), false);
});

test("the picker reads in the page's language", () => {
  const [empty, filled] = renderPreviews([{ value: "" }, { value: "https://images.example/logo.png" }], "zh-CN");
  assert.ok(empty.includes(">上传图片</p>"));
  assert.ok(empty.includes('aria-label="上传代币图片"'));
  assert.ok(filled.includes(">更换图片</p>"));
  assert.ok(filled.includes('<img src="https://images.example/logo.png"'), "the URL is the same in every language");
});

test("every upload failure the picker translates is one the route really gives, and its English reads as the reason did", () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const picker = read("./ImageUpload.tsx");
  // the reasons as the upload route and the image checks it runs write them
  const given = ["../../app/api/launch/image/route.ts", "../../lib/launchpad/images.ts", "../../lib/launchpad/imageProcess.ts"].map(read).join("\n");
  const mapped = new Map([...picker.matchAll(/^\s*\["([^"]+)", "(\w+)"\],$/gm)].map((m) => [m[2], m[1]]));
  for (const [key, english] of Object.entries(en.launch.upload.reasons)) {
    if (key === "tooBig") continue; // the template, read back by pattern below
    assert.equal(mapped.get(key), english, `REASONS maps "${english}" to upload.reasons.${key}`);
    assert.ok(given.includes(`"${english}"`), `upload.reasons.${key} ("${english}") is not a reason the code gives`);
  }
  assert.equal(en.launch.upload.reasons.tooBig, "image must be ≤ {mb} MB");
  assert.match(given, /`image must be ≤ \$\{\w+ \/ 1024 \/ 1024\} MB`/);
  assert.ok(picker.includes(String.raw`/^image must be ≤ ([\d.]+) MB$/.exec(reason)`));
  // a refused upload is shown through the map; anything else (a network error) reads as it came
  assert.match(picker, /throw new Error\(j\.error \? explain\(j\.error\) : t\("failedStatus", \{ status: r\.status \}\)\)/);
  assert.equal(en.launch.upload.failedStatus, "upload failed ({status})");
});
