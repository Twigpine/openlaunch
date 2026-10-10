import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { walletHue, walletMark } from "../lib/wallet-mark.ts";

type AvatarProps = { address: string; size?: number };
type Element = { type: string; props: Record<string, unknown>; key?: string };

// Exercise the actual component with its real address fingerprint and an inert
// JSX runtime. No React renderer, wallet provider, or network is required.
const source = readFileSync(new URL("./WalletAvatar.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const jsx = (type: string, props: Element["props"], key?: string): Element => ({ type, props, key });
const imports: Record<string, unknown> = {
  "react/jsx-runtime": { jsx, jsxs: jsx },
  "@/lib/wallet-mark": { walletHue, walletMark },
  "./WalletAvatar.module.css": { default: { avatar: "wallet-avatar", base: "wallet-avatar-base" } },
};
const exported = {} as { default: (props: AvatarProps) => Element };
runInNewContext(compiled, {
  exports: exported,
  require: (id: string) => {
    assert.ok(Object.hasOwn(imports, id), `Unexpected production import: ${id}`);
    return imports[id];
  },
  fetch: () => assert.fail("Wallet avatars must not request remote identities"),
});
const render = exported.default;
const address = "0x49a5000000000000000000000000000000008576";

function descendants(element: Element): Element[] {
  const found: Element[] = [];
  function visit(child: unknown) {
    if (Array.isArray(child)) {
      for (const item of child) visit(item);
    } else if (child && typeof child === "object" && "type" in child && "props" in child) {
      const node = child as Element;
      found.push(node);
      visit(node.props.children);
    }
  }
  visit(element.props.children);
  return found;
}

function cells(element: Element) {
  return descendants(element).filter((node) => node.type === "rect").map(({ props }) => ({ x: props.x, y: props.y }));
}

test("wallet avatars retain the same full-address geometry at every supported display size", () => {
  for (const size of [24, 28, 40, 48]) {
    for (const normalizedAddress of [address, address.toUpperCase(), "0x49A5000000000000000000000000000000008576"]) {
      const avatar = render({ address: normalizedAddress, size });
      assert.equal(avatar.type, "svg");
      assert.equal(avatar.props.width, size);
      assert.equal(avatar.props.height, size);
      assert.equal(avatar.props.viewBox, "0 0 40 40");
      assert.deepEqual(cells(avatar), walletMark(address));
      assert.equal((avatar.props.style as Record<string, unknown>)["--wallet-hue"], walletHue(address));
    }
  }
  assert.equal(render({ address }).props.width, 28);
  assert.equal(render({ address }).props.height, 28);
});

test("wallet avatar identity follows the wallet, not its token, chain, or shortened label", () => {
  const otherWallet = "0x49a5000000000000000100000000000000008576";
  assert.equal(address.slice(0, 6), otherWallet.slice(0, 6));
  assert.equal(address.slice(-4), otherWallet.slice(-4));
  assert.notDeepEqual(cells(render({ address })), cells(render({ address: otherWallet })));
  assert.notEqual(
    (render({ address }).props.style as Record<string, unknown>)["--wallet-hue"],
    (render({ address: otherWallet }).props.style as Record<string, unknown>)["--wallet-hue"],
  );
  for (const context of [
    { address, chain: "base", token: "0x1111111111111111111111111111111111111111" },
    { address, chain: "robinhood", token: "0x2222222222222222222222222222222222222222" },
  ]) {
    assert.deepEqual(cells(render(context)), walletMark(address));
    assert.equal((render(context).props.style as Record<string, unknown>)["--wallet-hue"], walletHue(address));
  }
  assert.match(source, /walletMark\(address\)/);
  assert.match(source, /walletHue\(address\)/);
  assert.doesNotMatch(source, /walletMark\([^)]*(?:token|chain|shortAddr)/);
  assert.doesNotMatch(source, /walletHue\([^)]*(?:token|chain|shortAddr)/);
});

test("wallet avatars remain decorative, unfocusable, local, and deterministic", () => {
  const avatar = render({ address });
  assert.equal(avatar.props["aria-hidden"], "true");
  assert.equal(avatar.props.focusable, "false");
  assert.equal(avatar.props.tabIndex, undefined);
  assert.ok(descendants(avatar).every((node) => node.type === "circle" || node.type === "rect"));
  const geometry = descendants(avatar).filter((node) => node.type === "rect");
  assert.equal(new Set(geometry.map((node) => node.key)).size, geometry.length);
  const helper = readFileSync(new URL("../lib/wallet-mark.ts", import.meta.url), "utf8");
  for (const implementation of [source, helper]) {
    assert.doesNotMatch(implementation, /\b(?:fetch|XMLHttpRequest|WebSocket|Image)\s*\(|https?:\/\/|Math\.random|crypto\.|Date\.|new Date|dangerouslySetInnerHTML/);
  }
});

test("every wallet color keeps at least 4.5:1 contrast against its light and dark avatar background", () => {
  const css = readFileSync(new URL("./WalletAvatar.module.css", import.meta.url), "utf8");
  const readColors = (property: "color" | "fill") => Array.from(
    css.matchAll(new RegExp(`\\b${property}:\\s*hsl\\(var\\(--wallet-hue\\)\\s+([\\d.]+)%\\s+([\\d.]+)%\\)`, "g")),
    (match) => ({ saturation: Number(match[1]), lightness: Number(match[2]) }),
  );
  const foregrounds = readColors("color");
  const backgrounds = readColors("fill");
  assert.equal(foregrounds.length, 2, "read both actual light and dark foregrounds");
  assert.equal(backgrounds.length, 2, "read both actual light and dark backgrounds");
  assert.ok(backgrounds[0].saturation >= 80 && backgrounds[0].lightness <= 88, "light backplates retain a visible, saturated fill");
  assert.ok(backgrounds[1].saturation >= 65 && backgrounds[1].lightness >= 24, "dark backplates retain a visible, saturated fill");
  assert.match(css, /:global\(\.dark\)\s+\.avatar/);
  assert.match(css, /:global\(\.dark\)\s+\.base/);

  function luminance(hue: number, { saturation, lightness }: { saturation: number; lightness: number }) {
    const light = lightness / 100;
    const amplitude = saturation / 100 * Math.min(light, 1 - light);
    const rgb = [0, 8, 4].map((channel) => {
      const position = (channel + hue / 30) % 12;
      const value = light - amplitude * Math.max(-1, Math.min(position - 3, 9 - position, 1));
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  }

  const hues = new Set(Array.from({ length: 256 }, (_, index) => walletHue(`0x${index.toString(16).padStart(40, "0")}`)));
  assert.equal(hues.size, 12);
  for (const hue of hues) {
    for (const [index, theme] of ["light", "dark"].entries()) {
      const front = luminance(hue, foregrounds[index]);
      const back = luminance(hue, backgrounds[index]);
      const ratio = (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05);
      assert.ok(ratio >= 4.5, `${theme} hue ${hue} contrast ${ratio.toFixed(2)}:1 must be at least 4.5:1`);
    }
  }
});

test("community posts lead with the author wallet and retain smaller token context", () => {
  const feed = readFileSync(new URL("./sections/CommunityFeed.tsx", import.meta.url), "utf8");
  const headingStart = feed.indexOf("<div className={styles.postHeading}>");
  const bodyStart = feed.indexOf("<p className={styles.postBody}>", headingStart);
  assert.ok(headingStart >= 0 && bodyStart > headingStart);
  const heading = feed.slice(headingStart, bodyStart);
  assert.match(heading, /<(?:WalletAvatar|WhoAvatar) address=\{post\.wallet\} size=\{40\}/);
  assert.match(heading, /<h3 title=\{post\.wallet\}>[\s\S]*?shortAddr\(post\.wallet\)/);
  assert.doesNotMatch(heading, /<TokenAvatar/);
  assert.match(feed.slice(bodyStart), /<TokenAvatar chain=\{post\.chain\} token=\{post\.token\} symbol=\{post\.symbol \?\? "\?"\} size=\{20\}/);
  assert.match(feed.slice(bodyStart), /On <strong>\{post\.name \|\| post\.symbol \|\| shortAddr\(post\.token\)\}/);
});

test("homepage posts and shared token replies use the author's wallet avatar", () => {
  const posts = readFileSync(new URL("./launchpad/Posts.tsx", import.meta.url), "utf8");
  const itemStart = posts.indexOf("function PostItem(");
  const feedStart = posts.indexOf("export function PostsFeed(");
  assert.ok(itemStart >= 0 && feedStart > itemStart);
  const item = posts.slice(itemStart, feedStart);
  const feed = posts.slice(feedStart);
  assert.match(item, /<(?:WalletAvatar|WhoAvatar) address=\{p\.wallet\} size=\{24\}/);
  assert.match(item, /title=\{p\.wallet\}/);
  assert.match(feed, /<(?:WalletAvatar|WhoAvatar) address=\{p\.wallet\}/);
  assert.match(feed, /title=\{p\.wallet\}>\{shortAddr\(p\.wallet\)\}/, "no profile: the short address, as before");
  assert.match(posts.slice(0, itemStart), /<PostItem p=\{p\}/);
  assert.match(posts.slice(0, itemStart), /<PostItem p=\{r\}/);
  assert.doesNotMatch(posts, /<(?:WalletAvatar|WhoAvatar)[^>]*address=\{[^}]*(?:token|chain)\}/);
});

test("the connected wallet menu shares the same avatar implementation", () => {
  const menu = readFileSync(new URL("./WalletMenu.tsx", import.meta.url), "utf8");
  assert.match(menu, /import WalletAvatar from "\.\/WalletAvatar"/);
  assert.match(menu, /<WalletAvatar address=\{address\} \/>/);
  assert.match(menu, /<WalletAvatar address=\{address\} size=\{48\}/);
  assert.doesNotMatch(menu, /function WalletMark\b|walletMark\(/);
});
