import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("workspace gutters expand without imposing a desktop width cap", () => {
  const css = source("../app/globals.css");
  const shell = css.match(/\.workspace-shell\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.match(shell, /width:\s*100%/);
  assert.match(shell, /min-width:\s*0/);
  assert.match(shell, /padding-inline:\s*var\(--workspace-gutter\)/);
  assert.doesNotMatch(shell, /max-width/);
  assert.match(css, /--workspace-gutter:\s*16px/);
  assert.match(css, /min-width:\s*640px[^\n]+--workspace-gutter:\s*24px/);
  assert.match(css, /min-width:\s*1280px[^\n]+--workspace-gutter:\s*32px/);
});

test("home isolates its readable hero from the fluid market, including loading", () => {
  for (const path of ["../app/(home)/page.tsx", "../app/(home)/loading.tsx"]) {
    const file = source(path);
    assert.doesNotMatch(file.match(/<main[^>]+>/)?.[0] ?? "", /max-w-/);
    assert.match(file, /workspace-shell/);
    assert.equal(file.match(/max-w-6xl/g)?.length, 1);
    assert.match(file, /xl:grid-cols-\[minmax\(0,1fr\)_17rem\]/);
  }
});

test("token market and loading preserve the fixed trade rail in a fluid shell", () => {
  for (const path of ["../app/t/[chain]/[token]/page.tsx", "../app/t/[chain]/[token]/loading.tsx"]) {
    const file = source(path);
    assert.match(file, /<main className="workspace-shell/);
    assert.match(file, /lg:grid-cols-\[minmax\(0,1fr\)_21rem\]/);
  }
});

test("ledger header, data rows and placeholders share responsive tracks", () => {
  const row = source("./launchpad/LaunchRow.tsx");
  assert.match(row, /const columns = "launch-ledger"/);
  assert.equal(row.match(/\$\{columns\}/g)?.length, 2);
  assert.match(source("./Skeleton.tsx"), /className="launch-ledger grid/);
  const css = source("../app/globals.css");
  assert.match(css, /min-width:\s*640px[\s\S]*grid-template-columns:\s*minmax\(0, 1\.65fr\) minmax\(7rem, \.72fr\) minmax\(9\.5rem, \.9fr\)/);
  assert.match(css, /min-width:\s*1024px[\s\S]*grid-template-columns:\s*minmax\(20rem, 36rem\) minmax\(8\.5rem, 1fr\) minmax\(7\.5rem, \.8fr\) minmax\(10rem, 1fr\)/);
});

test("market navigation is docked without changing the server scroll snapshot", () => {
  assert.match(source("./HeaderNav.tsx"), /const workspace = pathname === "\/" \|\| pathname\.startsWith\("\/t\/"\)/);
  assert.match(source("./HeaderNav.tsx"), /<Navbar className="top-0" docked=\{workspace\}/);
  const shell = source("./navigation-shell.tsx");
  assert.match(shell, /const serverIsFloating = \(\) => false/);
  assert.match(shell, /const visible = scrolled && !docked/);
});
