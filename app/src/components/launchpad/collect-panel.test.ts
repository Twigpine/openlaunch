import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./CollectPanel.tsx", import.meta.url), "utf8");
const actions = readFileSync(new URL("../../lib/launchpad/fee-actions.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../../app/t/[chain]/[token]/page.tsx", import.meta.url), "utf8");

// Every collect pays beneficiaries both pool currencies: the quote and the launched token.
test("the token page hands the fee panel both sides of the collected and burned totals", () => {
  for (const prop of ["token={l.token as Address}", "collectedQuote={l.fees_quote_collected}", "collectedToken={l.fees_token_collected}", "burnedQuote={l.fees_quote_burned}", "burnedToken={l.fees_token_burned}", "priceQuote={l.price_quote}"]) {
    assert.ok(page.includes(prop), prop);
  }
});

test("the fee panel shows collected, burned and paid amounts for the quote and the token", () => {
  assert.match(source, /ft\(isBurnOnly \? burned\.token : collected\.token\)/);
  assert.match(source, /fq\(burned\.quote\)/);
  assert.match(source, /ft\(burned\.token\)/);
  assert.match(source, /Allocated to beneficiaries/);
  assert.match(source, /\{fq\(toPeople\.quote\)\}.*\{ft\(toPeople\.token\)\}/);
  // USD includes the token side at the pool price and says so when it does
  assert.match(source, /feeSidesUsd\(sides, quote\.decimals, priceQuote, quoteUsd\)/);
  assert.match(source, /sides\.token > 0n \? "≈ " : ""/);
});

test("claim reads and withdraws each currency separately", () => {
  assert.match(source, /useReadContracts\(/);
  // the reads and the claim call live in lib/launchpad/fee-actions.ts, shared with the dashboard
  assert.match(source, /claimableContracts\(target, CHAIN\.id, address, quote\.address, token\)/);
  assert.match(actions, /\[quote, token\]\.map\(\(currency\)/);
  assert.match(actions, /functionName: "claimable" as const, args: \[account, currency\] as const/);
  assert.match(source, /\{ currency: quote\.address, raw: \(mine\.data\?\.\[0\]\?\.result/);
  assert.match(source, /\{ currency: token, raw: \(mine\.data\?\.\[1\]\?\.result/);
  assert.match(source, /onClick=\{\(\) => void send\("claim", c\.currency\)\}/);
  assert.match(source, /claimRequest\(pub, target, address, currency \?\? quote\.address\)/);
  assert.match(actions, /functionName: "claim", args: isQuoteFeeLaunch\(t\.launch\) \? \[t\.tokenId\] : \[currency\]/);
});

test("pending feedback stays on the button whose transaction was sent", () => {
  assert.match(source, /\{ k: "sent"; hash: Hex; what: "collect" \| "claim"; currency\?: Address \}/);
  assert.match(source, /setPhase\(\{ k: "sent", hash, what, currency \}\)/);
  // a claim in flight must not show "Confirming…" on Collect, and vice versa
  assert.match(source, /phase\.k === "sent" && phase\.what === "collect" \? <><Spinner size=\{13\} \/> Confirming…/);
  assert.match(source, /phase\.k === "sent" && phase\.what === "claim" && phase\.currency === c\.currency \? <><Spinner size=\{13\} \/> Confirming…/);
  assert.doesNotMatch(source, /: phase\.k === "sent" \? <><Spinner/);
});
