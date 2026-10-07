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

test("the headline is stepped so it stays two lines, and the hero grid has three arrangements", () => {
  for (const step of ["text-[34px]", "min-[400px]:text-[40px]", "min-[480px]:text-[48px]", "sm:text-[60px]", "md:text-[44px]", "lg:text-[56px]", "xl:text-[68px]"]) {
    assert.ok(HERO.headline.split(" ").includes(step), `headline size step ${step}`);
  }
  // the shortest laptop window (about 657px under the toolbars) gets a smaller headline and copy, so the totals stay in view
  assert.ok(HERO.headline.split(" ").includes("[@media(min-width:1024px)_and_(max-height:700px)]:text-[52px]"));
  assert.ok(HERO.copy.split(" ").includes("[@media(min-width:1024px)_and_(max-height:700px)]:text-base"));
  assert.ok(HERO.section.split(" ").includes("lg:pt-4"), "tight rhythm from 1024px");
  // phones: copy, the locker, then the totals. 768px: text beside the locker, totals under both. 1024px: the totals
  // move up under the text and the locker spans both rows, with copy hugging its row's bottom and the totals its top
  assert.match(heroCss, /\.layout \{[^}]*align-items: center;[^}]*grid-template-columns: minmax\(0, 1fr\); grid-template-areas: "copy" "stage" "totals"; \}/);
  assert.match(heroCss, /@media \(min-width: 768px\) \{ \.layout \{ grid-template-columns: minmax\(0, 1\.06fr\) minmax\(0, 1fr\); grid-template-areas: "copy stage" "totals totals"; \} \}/);
  assert.match(heroCss, /@media \(min-width: 1024px\) \{\n\s*\.layout \{ grid-template-areas: "copy stage" "totals stage";[^}]*\}\n\s*\.copyArea \{ align-self: end; \}\n\s*\.totalsArea \{ align-self: start; \}/);
  assert.match(heroCss, /\.stage \{ grid-area: stage;/);
});

test("the hero has two ways in, and the proofs are chips that are easy to hit", () => {
  // the filled button, and the way in for someone who wants it explained first: the rules guide
  assert.match(hero, /<HeroCtaLink id="hero-cta" href="\/launch"/);
  assert.match(hero, /<Link href="\/rules#launchpad" aria-label="See how it works" className="group inline-flex min-h-12 /);
  assert.match(hero, /<span aria-hidden="true" className="hidden sm:inline">See how it works<\/span>/);
  // phones: both buttons share one row, and below 380px the second is just its tile so the filled one keeps its words
  assert.ok(HERO.actions.split(" ").includes("items-center") && !HERO.actions.split(" ").includes("flex-col"));
  assert.match(hero, /max-\[379px\]:hidden sm:hidden">How it works</);
  // the chain chip links to the same guide and appears from 640px (the copy below names the chains on a phone)
  assert.match(hero, /<Link href="\/rules#launchpad" className=\{HERO\.chip\}>/);
  assert.ok(HERO.chip.split(" ").includes("hidden") && HERO.chip.split(" ").includes("sm:inline-flex"));
  // three proof chips, each at least 32px tall (36px from 640px), each a place to check the claim
  assert.equal((hero.match(/className=\{proof\}/g) ?? []).length, 3, "MIT licensed, Source on GitHub, Verified contracts");
  assert.match(hero, /const proof = "inline-flex min-h-8 [^"]*sm:min-h-9 /);
  assert.ok(HERO.proofs.split(" ").includes("gap-2"), "wrapped proof rows sit 8px apart");
  assert.doesNotMatch(hero, /See what&apos;s trending|#trending/, "the old second link is gone");
});

test("the hero and its loading skeleton render the same layout strings", () => {
  for (const file of [hero, skeleton]) {
    assert.match(file, /import \{ HERO \} from "(?:\.|@\/components\/launchpad)\/hero-layout"/);
    // the chip is drawn by the skeleton as a plain placeholder; every other string is shared
    for (const key of Object.keys(HERO).filter((k) => k !== "chip")) assert.ok(file.includes(`HERO.${key}`), `HERO.${key} is used`);
  }
  assert.ok(hero.includes("HERO.chip"));
  // nothing about the hero grid is typed a second time in the skeleton
  assert.doesNotMatch(skeleton, /grid-cols-\[minmax\(0,1\.\d+fr\)/);
  // the grid, the stage, the locker box and the totals come from the real stylesheets, so the short-screen rules apply to both
  assert.match(skeleton, /import hero from "@\/components\/launchpad\/LaunchHero\.module\.css"/);
  assert.match(skeleton, /import machine from "@\/components\/launchpad\/LaunchMachine\.module\.css"/);
  assert.match(skeleton, /import totals from "@\/components\/launchpad\/LaunchMechanism\.module\.css"/);
  for (const cls of ["hero.hero", "hero.layout", "hero.copyArea", "hero.stage", "hero.totalsArea", "machine.machine", "machine.detail", "totals.panel", "totals.readings", "totals.lead", "totals.figure", "totals.breakdown"]) {
    assert.ok(skeleton.includes(cls), `skeleton uses ${cls}`);
  }
  assert.ok(hero.includes("${HERO.section} ${styles.hero}") && hero.includes("<div className={styles.layout}>") && hero.includes("<div className={styles.totalsArea}>"));
  // the same three areas, in the same order, in both
  for (const [file, names] of [[hero, ["styles.copyArea", "styles.stage", "styles.totalsArea"]], [skeleton, ["hero.copyArea", "hero.stage", "hero.totalsArea"]]] as const) {
    const at = names.map((name) => file.indexOf(name));
    assert.ok(at.every((i) => i >= 0) && [...at].sort((a, b) => a - b).join() === at.join(), "copy, the locker, then the totals");
  }
});

test("the skeleton follows the page order: hero with its totals, Trending, live panel, list", () => {
  const at = ["hero.layout", "totals.panel", "sm:grid-cols-2 lg:grid-cols-10 lg:grid-rows-2", "relative h-[687px] rounded-3xl border border-line bg-card/70 p-4 shadow-card sm:h-[463px] sm:p-6", "<SkRow "].map((mark) => skeleton.indexOf(mark));
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
  assert.match(block, /\.layout \{ row-gap: \.75rem; \}/);
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
  // one big figure: 30px on phones, 40px from 640px, 46px from 1024px (where it is a card in the hero's left column); the rest 20px then 24px
  assert.deepEqual([...totalsCss.matchAll(/\.lead \{[^}]*--fig-max: (\d+)px/g)].map((m) => m[1]), ["30", "40", "46"]);
  assert.deepEqual([...totalsCss.matchAll(/\.reading \{[^}]*--fig-max: (\d+)px/g)].map((m) => m[1]), ["20", "24", "24"]);
});

test("the strip is one hairline panel with a registered grid and no decoration", () => {
  assert.match(rule(totalsCss, ".panel"), /border: 1px solid var\(--color-line\); border-radius: 16px; background: var\(--color-card\);/);
  assert.match(rule(totalsCss, ".readings"), /gap: 1px; background: var\(--color-line\);/);
  // a card from 1024px (the hero's left column is narrow): Trades down the left side, the other four as a 2x2 beside it, no notes
  assert.match(totalsCss, /@media \(min-width: 1024px\) \{\n\s*\.readings \{ grid-template-columns: minmax\(0, 1\.5fr\) repeat\(2, minmax\(0, 1fr\)\); \}[\s\S]*?\.lead \{[^}]*grid-column: 1; grid-row: span 4;[^}]*\}[\s\S]*?\.note \{ display: none; \}/);
  // four columns with Trades on its own row from 640px
  assert.match(totalsCss, /@media \(min-width: 640px\) \{\n\s*\.readings \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); \}[\s\S]*?\.lead \{[^}]*grid-column: 1 \/ -1; \}/);
  // phones: notes hidden, so every row is label and figure only
  assert.ok(totalsCss.includes("\n.note { display: none; }\n"));
  // the tick ruler lined up with nothing and is gone
  assert.doesNotMatch(totals + totalsCss, /ruler/i);
  assert.match(totalsCss, /\.breakdown summary:focus-visible \{ outline-offset: -2px; \}/);
  // design tokens only; the one literal is the opaque stop of the stage's fade mask, which is not a colour on screen
  assert.doesNotMatch(totalsCss + heroCss.replace(/mask-image:[^;]+;/g, ""), /#[0-9a-f]{3,8}\b/i, "no raw hex colours");
});
