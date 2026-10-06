import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { HERO } from "./hero-layout.ts";

/**
 * Source contracts for the home page's first screen: the hero grid and its loading skeleton share their class
 * strings, the totals strip keeps its five readings, its latch and its type rules, and short laptop screens get the
 * compact locker. Browser QA measures the pixels (two headline lines at every width, the strip on the first screen,
 * no clipped figure); these keep the decisions from being edited away.
 */
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const hero = read("./LaunchHero.tsx");
const heroCss = read("./LaunchHero.module.css");
const totals = read("./LaunchMechanism.tsx");
const totalsCss = read("./LaunchMechanism.module.css");
const skeleton = read("../../app/(home)/loading.tsx");
const rule = (css: string, selector: string) => css.split("\n").find((line) => line.startsWith(`${selector} {`)) ?? "";

test("the headline is stepped so it stays two lines, and the hero is two columns from 768px", () => {
  for (const step of ["text-[34px]", "min-[400px]:text-[40px]", "min-[480px]:text-[48px]", "sm:text-[60px]", "md:text-[44px]", "lg:text-[56px]", "xl:text-[68px]"]) {
    assert.ok(HERO.headline.split(" ").includes(step), `headline size step ${step}`);
  }
  assert.ok(HERO.grid.includes("md:grid-cols-[minmax(0,1.06fr)_minmax(0,1fr)]"));
  assert.ok(HERO.grid.split(" ").includes("items-center"), "text and locker are centred on each other");
  assert.ok(HERO.grid.split(" ").includes("gap-y-6") && HERO.strip.split(" ").includes("mt-5"), "tight gaps on phones");
  assert.ok(HERO.section.split(" ").includes("lg:pt-4") && HERO.strip.split(" ").includes("lg:mt-5"), "tight rhythm from 1024px");
});

test("the hero's second link is a real touch target on phones and the proofs are easy to hit", () => {
  assert.match(hero, /<a href="#trending" className="inline-flex min-h-11 items-center justify-center [^"]*sm:min-h-0">/);
  assert.equal((hero.match(/min-h-6 items-center/g) ?? []).length, 3, "MIT licensed, Source on GitHub, Verified contracts");
  assert.ok(HERO.proofs.split(" ").includes("gap-y-2"), "wrapped proof rows sit 8px apart");
  assert.match(hero, /<HeroCtaLink id="hero-cta" href="\/launch"/);
});

test("the hero and its loading skeleton render the same layout strings", () => {
  for (const file of [hero, skeleton]) {
    assert.match(file, /import \{ HERO \} from "(?:\.|@\/components\/launchpad)\/hero-layout"/);
    for (const key of Object.keys(HERO)) assert.ok(file.includes(`HERO.${key}`), `HERO.${key} is used`);
  }
  // nothing about the hero grid is typed a second time in the skeleton
  assert.doesNotMatch(skeleton, /grid-cols-\[minmax\(0,1\.\d+fr\)/);
  // the stage, the locker box and the strip come from the real stylesheets, so the short-screen rules apply to both
  assert.match(skeleton, /import hero from "@\/components\/launchpad\/LaunchHero\.module\.css"/);
  assert.match(skeleton, /import machine from "@\/components\/launchpad\/LaunchMachine\.module\.css"/);
  assert.match(skeleton, /import totals from "@\/components\/launchpad\/LaunchMechanism\.module\.css"/);
  for (const cls of ["hero.hero", "hero.stage", "hero.strip", "machine.machine", "machine.detail", "totals.panel", "totals.readings", "totals.lead", "totals.figure", "totals.breakdown"]) {
    assert.ok(skeleton.includes(cls), `skeleton uses ${cls}`);
  }
  assert.ok(hero.includes("${HERO.section} ${styles.hero}") && hero.includes("${HERO.strip} ${styles.strip}"));
});

test("the skeleton follows the page order: hero, totals, Trending, river, list", () => {
  const at = ["HERO.grid", "totals.panel", "sm:grid-cols-2 lg:grid-cols-10 lg:grid-rows-2", "relative h-[687px] rounded-3xl border border-line bg-card/70 p-4 shadow-card sm:h-[463px] sm:p-6", "<SkRow "].map((mark) => skeleton.indexOf(mark));
  assert.ok(at.every((i) => i >= 0), `every block is there: ${at}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  // the board's own grid: a leader over two rows and four runners
  assert.match(skeleton, /sm:col-span-2 [^"]*lg:col-span-4 lg:row-span-2/);
  assert.match(skeleton, /\{\[0, 1, 2, 3\]\.map\(\(i\) => \(\n\s*<div key=\{i\} className="[^"]*lg:col-span-3/);
});

test("short laptop screens get a smaller locker and tighter gaps", () => {
  const at = heroCss.indexOf("@media (min-width: 1024px) and (max-height: 840px)");
  assert.ok(at >= 0);
  const block = heroCss.slice(at);
  assert.match(block, /\.stage \{ --machine-max: 400px; --detail-min: 88px; \}/);
  assert.match(block, /\.hero \{ padding-top: \d+px; \}/);
  assert.match(block, /\.strip \{ margin-top: \d+px; \}/);
});

test("the totals strip has five readings in order, with Trades as the big one", () => {
  const labels = ["Trades", "Tokens launched", "All-time volume", "Fees to recipients", "Platform fee"];
  const at = labels.map((label) => totals.indexOf(`label="${label}"`));
  assert.ok(at.every((i) => i >= 0), "every reading is there");
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  assert.equal((totals.match(/<Reading /g) ?? []).length, 5);
  assert.match(totals, /<Reading lead label="Trades" note="buys and sells, all on-chain"/);
  assert.equal((totals.match(/<Reading lead /g) ?? []).length, 1, "one big figure");
  assert.match(totals, /label="Platform fee" note="to us, on every chain" tone="brand" chars=\{2\}>\$0<\/Reading>/);
  assert.match(totals, /label="Fees to recipients" note="to the wallets creators chose"[^\n]*tone="up"/);
  // a valid description list: each reading is a div holding one term and its two descriptions
  assert.match(totals, /<div className=\{[^\n]*\n\s*<dt className=\{styles\.label\}>\{label\}<\/dt>\n\s*<dd [^\n]*<\/dd>\n\s*<dd className=\{styles\.note\}>\{note\}<\/dd>\n\s*<\/div>/);
});

test("the strip names Robinhood Chain in full, in its notes and in the breakdown", () => {
  assert.match(totals, /import \{ CHAIN_KEYS, CHAIN_LABELS, chainList \} from "@\/lib\/chainPublic"/);
  assert.doesNotMatch(totals, /CHAIN_SHORT/);
  assert.match(totals, /note=\{`on \$\{chainList\("&", CHAIN_LABELS\)\}`\}/);
  assert.match(totals, />The numbers across \{chainList\("&", CHAIN_LABELS\)\}</);
  assert.match(totals, /\{CHAIN_LABELS\[k\]\} launches</);
});

test("the dollar readings are latched: shown totals change only when something happened on-chain", () => {
  assert.match(totals, /const \{ live, subscribe \} = useLive\(\);/);
  assert.match(totals, /const \[t, setT\] = useState\(live\.totals\);/);
  // replaced inside the poll listener (never in an effect body), and only for a trade, a launch, a price flag change
  // or a burn (raw on-chain amounts, which do not drift with the price)
  assert.match(totals, /useEffect\(\(\) => subscribe\(\(\{ totals \}\) => \{\n\s*setT\(\(shown\) => \(totals\.trades !== shown\.trades \|\| totals\.launches !== shown\.launches \|\| totals\.usd_partial !== shown\.usd_partial \|\| totals\.gitlawb_burned !== shown\.gitlawb_burned \|\| \(totals\.twig_burned \?\? shown\.twig_burned\) !== shown\.twig_burned \? totals : shown\)\);\n\s*\}\), \[subscribe\]\);/);
  // the drifting dollar sums themselves are never what lets a poll through
  assert.doesNotMatch(totals, /totals\.\w+_usd !== shown/);
  assert.doesNotMatch(totals, /const t = live\.totals/);
  assert.doesNotMatch(totals, /\bsetTimeout\s*\(|\bsetInterval\s*\(|\bfetch\s*\(/);
});

test("the two dollar figures explain themselves, and the ≈ note is readable without a mouse", () => {
  assert.match(totals, /usdNote \?\? `\$\{fmtUsd\(v\)\} · \$\{what\} valued at current rates`/);
  assert.match(totals, /title=\{usdTitle\(t\.volume_usd, "quote volume"\)\}/);
  assert.match(totals, /title=\{usdTitle\(t\.fees_to_creators_usd, "quote-asset fees"\)\}/, "fees are not volume");
  const details = totals.slice(totals.indexOf("<details"));
  assert.match(details, /\{usdNote \? <p className="[^"]*text-\[11px\][^"]*">≈ \{usdNote\}<\/p> : null\}/);
});

test("the strip's figures are mono, untracked, and sized so they never clip", () => {
  const figure = rule(totalsCss, ".figure");
  // bold figures set with negative tracking crowd their digits
  assert.match(figure, /letter-spacing: 0;/);
  assert.match(figure, /font-family: var\(--font-mono\);/);
  assert.match(figure, /font-weight: 700;/);
  assert.match(figure, /font-variant-numeric: tabular-nums;/);
  assert.match(figure, /white-space: nowrap;/);
  assert.match(figure, /container-type: inline-size;/);
  assert.doesNotMatch(totalsCss, /letter-spacing: -/);
  assert.match(rule(totalsCss, ".value"), /font-size: clamp\(\d+px, calc\(100cqi \/ \(var\(--chars\) \* \.\d+\)\), var\(--fig-max\)\);/);
  assert.match(totals, /style=\{\{ "--chars": chars \} as CSSProperties\}/);
  // one big figure: 30px on phones, 40px from 640px, 54px from 1024px; the rest 20px then 24px
  assert.deepEqual([...totalsCss.matchAll(/\.lead \{[^}]*--fig-max: (\d+)px/g)].map((m) => m[1]), ["30", "40", "54"]);
  assert.deepEqual([...totalsCss.matchAll(/\.reading \{[^}]*--fig-max: (\d+)px/g)].map((m) => m[1]), ["20", "24"]);
});

test("the strip is one hairline panel with a registered grid and no decoration", () => {
  assert.match(rule(totalsCss, ".panel"), /border: 1px solid var\(--color-line\); border-radius: 16px; background: var\(--color-card\);/);
  assert.match(rule(totalsCss, ".readings"), /gap: 1px; background: var\(--color-line\);/);
  // six columns with Trades over two from 1024px; four columns with Trades on its own row from 640px
  assert.match(totalsCss, /@media \(min-width: 1024px\) \{\n\s*\.readings \{ grid-template-columns: repeat\(6, minmax\(0, 1fr\)\); \}[\s\S]*?\.lead \{[^}]*grid-column: span 2; \}/);
  assert.match(totalsCss, /@media \(min-width: 640px\) \{\n\s*\.readings \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); \}[\s\S]*?\.lead \{[^}]*grid-column: 1 \/ -1; \}/);
  // phones: notes hidden, so every row is label and figure only
  assert.ok(totalsCss.includes("\n.note { display: none; }\n"));
  // the tick ruler lined up with nothing and is gone
  assert.doesNotMatch(totals + totalsCss, /ruler/i);
  assert.match(totalsCss, /\.breakdown summary:focus-visible \{ outline-offset: -2px; \}/);
  // design tokens only; the one literal is the opaque stop of the stage's fade mask, which is not a colour on screen
  assert.doesNotMatch(totalsCss + heroCss.replace(/mask-image:[^;]+;/g, ""), /#[0-9a-f]{3,8}\b/i, "no raw hex colours");
});
