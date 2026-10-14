import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const header = readFileSync(new URL("./HeaderNav.tsx", import.meta.url), "utf8");
const navbar = readFileSync(new URL("./navigation-shell.tsx", import.meta.url), "utf8");
const theme = readFileSync(new URL("./vendor/animated-theme-toggler.tsx", import.meta.url), "utf8");
const notices = readFileSync(new URL("./vendor/LICENSES.md", import.meta.url), "utf8");

// Source contracts complement keyboard/viewport browser checks. They do not
// simulate Next navigation, native focus, or CSS layout.
test("mobile Launch closes its menu and route changes reset persistent header state", () => {
  assert.match(header, /<LaunchCta block onNavigate=\{\(\) => setOpen\(false\)\} \/>/);
  const launchCta = header.slice(header.indexOf("function LaunchCta"), header.indexOf("function Mobile"));
  assert.match(launchCta, /href="\/launch"\s+onClick=\{onNavigate\}/);
  assert.match(header, /<Mobile key=\{pathname\}/);
  assert.match(header, /quietCta=\{heroCtaOnScreen\}/, "the hero/header CTA handoff is preserved");
});

test("the desktop tools stay icons so the Launch button fits the strip", () => {
  // the strip's room is fixed (the page column at rest, the 800px pill floating); a ⌘K hint or a "Bridge" label pushed
  // the Launch button past it. The fit itself is checked in a browser (1024–2560px, every wallet state).
  const desktop = header.slice(header.indexOf("function Desktop"), header.indexOf("function NavLinks"));
  assert.match(desktop, /<SearchTrigger onClick=\{onSearch\} \/>/);
  assert.match(desktop, /<BridgeButton compact \/>/);
  assert.doesNotMatch(header, /<kbd\b/);
  assert.match(navbar, /style=\{mobile \? undefined : \{ minWidth: 800 \}\}/);
});

test("Escape dismisses only an unconsumed menu event and returns focus to its toggle", () => {
  assert.match(navbar, /event\.key === "Escape" && !event\.defaultPrevented/);
  assert.match(navbar, /event\.preventDefault\(\);\s+onClose\(\)/);
  assert.match(header, /onClose=\{dismissMenu\}/);
  assert.match(header, /const dismissMenu = useCallback\(\(\) => \{\s+setOpen\(false\);\s+menuToggle\.current\?\.focus\(\)/);
  assert.match(header, /ref=\{menuToggle\}/);
  assert.match(header, /aria-expanded=\{open\}/);
  assert.match(header, /aria-controls="mobile-menu"/);
});

test("mobile menu stays scrollable within short and landscape viewports", () => {
  assert.match(navbar, /max-h-\[calc\(100dvh-6rem\)\]/);
  assert.match(navbar, /overflow-y-auto overscroll-contain/);
});

test("the original navigation shell has a stable scroll subscription and reduced-motion transitions", () => {
  assert.match(header, /from "\.\/navigation-shell"/);
  assert.doesNotMatch(header, /vendor\/resizable-navbar/);
  assert.match(navbar, /<header className=/);
  assert.match(navbar, /useSyncExternalStore\(subscribeToScroll, isFloating, serverIsFloating\)/);
  assert.match(navbar, /window\.scrollY > 100/);
  assert.match(navbar, /addEventListener\("scroll", notify, \{ passive: true \}\)/);
  assert.match(navbar, /removeEventListener\("scroll", notify\)/);
  assert.match(navbar, /removeEventListener\("keydown", onKeyDown\)/);
  assert.match(navbar, /duration: reduced \? 0 : 0\.28/);
  assert.match(navbar, /duration: reduced \? 0 : 0\.12/);
});

test("Coss recipes identify the MIT-licensed apps/ui source separately from the monorepo", () => {
  assert.match(notices, /apps\/ui\//);
  assert.match(notices, /MIT/);
  assert.match(notices, /https:\/\/github\.com\/cosscom\/coss\/blob\/main\/LICENSING\.md/);
  assert.match(notices, /https:\/\/coss\.com\/ui\/r\/tabs\.json/);
  assert.match(notices, /https:\/\/coss\.com\/ui\/r\/toggle-group\.json/);
});

test("vendored Magic UI keeps its upstream MIT notice", () => {
  assert.match(theme, /Copyright \(c\) Magic UI/);
  assert.match(theme, /\.\/LICENSES\.md/);
  assert.match(notices, /Copyright \(c\) Magic UI/);
  assert.match(notices, /The above copyright notice and this permission notice shall be included/);
  assert.match(notices, /https:\/\/github\.com\/magicuidesign\/magicui\/blob\/main\/LICENSE\.md/);
});
