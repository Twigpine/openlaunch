import { test } from "node:test";
import assert from "node:assert/strict";
import { BAR_MIN_PCT, BOARD_RUNNERS, FOCUS_HOLD_POLLS, barScale, barWidth, boardCells, changeWords, holdOnPoll, sameBoard, type BoardCell, type BoardHold } from "./trending-board.ts";
import { STRIP_SIZE } from "./ranking.ts";

/** Columns a cell takes in each grid: the block beside the leader is 2 wide from 1024px, the whole board is 2 wide from 640px. */
const lgArea = (c: BoardCell) => ({ half: 1, wide: 2, block: 4 })[c.lg];
const smCols = (c: BoardCell) => ({ half: 1, wide: 2 })[c.sm];
const kinds = (cells: BoardCell[]) => cells.map((c) => c.kind).join(" ");

test("the board is the leader plus the rest of the strip", () => {
  assert.equal(BOARD_RUNNERS, STRIP_SIZE - 1);
  assert.equal(BOARD_RUNNERS, 4, "the 2x2 block beside the leader");
});

test("boardCells: every count from 0 to 4 runners fills the 2x2 block exactly, with no hole", () => {
  for (let n = 0; n <= BOARD_RUNNERS; n++) {
    const cells = boardCells(n);
    assert.equal(cells.filter((c) => c.kind === "runner").length, n, `${n} runners get ${n} runner cells`);
    assert.equal(cells.reduce((sum, c) => sum + lgArea(c), 0), 4, `${n} runners: the desktop block is full`);
    assert.equal(cells.reduce((sum, c) => sum + smCols(c), 0) % 2, 0, `${n} runners: no orphan in the two-column grid`);
    assert.ok(cells.filter((c) => c.kind === "open").length <= 1, "at most one open spot");
    assert.equal(cells.findIndex((c) => c.kind === "open"), cells.some((c) => c.kind === "open") ? cells.length - 1 : -1, "the open spot comes last");
  }
});

test("boardCells: which cell spans what", () => {
  assert.deepEqual(boardCells(0), [{ kind: "open", lg: "block", sm: "wide" }], "a lone leader: one open spot the height of the board");
  assert.deepEqual(boardCells(1), [{ kind: "runner", lg: "wide", sm: "half" }, { kind: "open", lg: "wide", sm: "half" }]);
  assert.deepEqual(boardCells(2), [{ kind: "runner", lg: "wide", sm: "half" }, { kind: "runner", lg: "wide", sm: "half" }], "two runners take a row each, no placeholder");
  assert.equal(kinds(boardCells(3)), "runner runner runner open");
  assert.ok(boardCells(3).every((c) => c.lg === "half" && c.sm === "half"));
  assert.equal(kinds(boardCells(4)), "runner runner runner runner");
  assert.ok(boardCells(4).every((c) => c.lg === "half" && c.sm === "half"));
});

test("boardCells: odd input never breaks the grid", () => {
  assert.deepEqual(boardCells(9), boardCells(4), "more than the board holds: the board");
  assert.deepEqual(boardCells(-1), boardCells(0));
  assert.deepEqual(boardCells(Number.NaN), boardCells(0));
  assert.deepEqual(boardCells(2.9), boardCells(2));
});

test("barWidth: square-root scale against the most wallets on the board, with a floor and a ceiling", () => {
  assert.equal(barWidth(250, 250), 100, "the most wallets is the whole track");
  assert.equal(barWidth(144, 250), 75.9);
  assert.equal(barWidth(62.5, 250), 50, "a quarter of the wallets is half the bar");
  assert.equal(barWidth(10, 250), 20, "linear would be 4%");
  assert.equal(barWidth(1, 250), BAR_MIN_PCT, "one wallet still shows as a length");
  assert.equal(barWidth(1, 123456), BAR_MIN_PCT);
  assert.equal(barWidth(300, 250), 100, "a count above the scale stops at the track");
  assert.equal(barWidth(0, 250), 0, "no wallets, no bar");
  assert.equal(barWidth(-3, 250), 0);
  assert.equal(barWidth(Number.NaN, 250), 0);
  assert.equal(barWidth(5, 0), 100, "an empty scale cannot shrink the others");
  assert.equal(barWidth(0, 0), 0);
});

test("barWidth never leaves the track and never shrinks as wallets grow", () => {
  let last = 0;
  for (let w = 0; w <= 260; w++) {
    const pct = barWidth(w, 250);
    assert.ok(pct >= 0 && pct <= 100, `${w} wallets: ${pct}%`);
    assert.ok(pct >= last, `${w} wallets is not shorter than ${w - 1}`);
    last = pct;
  }
});

test("barScale: the board's largest count, so a leader with fewer wallets than a runner cannot flatten the bars", () => {
  assert.equal(barScale([250, 144, 68, 58, 44]), 250, "usually the leader's");
  // a fresh token leads two older ones with more wallets (the score boosts tokens under six hours old)
  const board = [100, 140, 120];
  const scale = barScale(board);
  assert.equal(scale, 140);
  const bars = board.map((n) => barWidth(n, scale));
  assert.equal(bars[1], 100);
  assert.equal(new Set(bars).size, 3, "three different counts, three different bars");
  assert.ok(bars[0] < bars[2] && bars[2] < bars[1]);
  assert.equal(barScale([]), 0);
  assert.equal(barScale([0, 0]), 0);
  assert.equal(barScale([Number.NaN, 3]), 3);
});

test("holdOnPoll: a mouse over the board holds for as long as it stays", () => {
  let hold: BoardHold = { pointer: true, focus: false, focusPolls: 0 };
  for (let poll = 1; poll <= 20; poll++) {
    const next = holdOnPoll(hold);
    assert.equal(next.held, true, `poll ${poll}`);
    hold = next;
  }
  assert.equal(holdOnPoll({ pointer: false, focus: false, focusPolls: 0 }).held, false, "nobody there: re-sort");
});

test("holdOnPoll: keyboard focus holds three polls, then lets go", () => {
  let hold: BoardHold = { pointer: false, focus: true, focusPolls: 0 };
  const held: boolean[] = [];
  for (let poll = 1; poll <= FOCUS_HOLD_POLLS + 2; poll++) {
    const next = holdOnPoll(hold);
    held.push(next.held);
    hold = next;
  }
  assert.deepEqual(held, [true, true, true, false, false]);
  assert.deepEqual(hold, { pointer: false, focus: false, focusPolls: 0, held: false }, "the released focus stays released until a new focus event");
});

test("holdOnPoll: a released focus does not release the mouse, and a fresh focus starts a fresh count", () => {
  const spent = holdOnPoll({ pointer: true, focus: true, focusPolls: FOCUS_HOLD_POLLS });
  assert.deepEqual(spent, { pointer: true, focus: false, focusPolls: 0, held: true });
  assert.equal(holdOnPoll({ pointer: false, focus: true, focusPolls: 0 }).focusPolls, 1);
  assert.equal(holdOnPoll({ pointer: false, focus: false, focusPolls: 2 }).focusPolls, 0, "a count without a focus is dropped");
});

test("sameBoard: a hold keeps the order of the same tokens in the same window, and nothing else", () => {
  const row = (token: string, chain = "base") => ({ chain, token });
  const shown = { window: "1h", items: [row("0xA"), row("0xB"), row("0xC")] };
  assert.equal(sameBoard(shown, { window: "1h", items: [row("0xC"), row("0xA"), row("0xB")] }), true, "a pure re-sort is what a hold is for");
  assert.equal(sameBoard(shown, { window: "1h", items: [row("0xa"), row("0xb"), row("0xc")] }), true, "address case does not matter");
  assert.equal(sameBoard(shown, { window: "24h", items: shown.items }), false, "the window changed: \"Leading\" and \"Last hour\" would be false");
  assert.equal(sameBoard(shown, { window: "1h", items: [row("0xB"), row("0xC")] }), false, "a shown token left the ranking: its card would freeze");
  assert.equal(sameBoard(shown, { window: "1h", items: [row("0xB"), row("0xC"), row("0xD")] }), false, "replaced by a newcomer");
  assert.equal(sameBoard(shown, { window: "1h", items: [row("0xD"), row("0xA"), row("0xB"), row("0xC")] }), true, "a newcomer waits while every shown card is still true");
  assert.equal(sameBoard(shown, { window: "1h", items: [row("0xA"), row("0xB"), row("0xC", "robinhood")] }), false, "keys are chain-scoped");
  assert.equal(sameBoard({ window: "24h", items: [] }, { window: "24h", items: [row("0xA")] }), false, "an empty board has no order to keep: the first token shows at once");
  assert.equal(sameBoard(shown, { window: "1h", items: [] }), false);
});

test("changeWords: the chip, spoken", () => {
  assert.equal(changeWords(0.2732), "up 27% since launch");
  assert.equal(changeWords(0.064), "up 6.4% since launch");
  assert.equal(changeWords(-0.034), "down 3.4% since launch");
  assert.equal(changeWords(-0.42), "down 42% since launch");
  assert.equal(changeWords(18.7), "up 19.7× since launch", "a multiple stays a multiple");
  assert.equal(changeWords(0), "unchanged since launch");
  assert.equal(changeWords(0.0001), "unchanged since launch", "rounds to 0.0%");
  assert.equal(changeWords(Number.NaN), "change since launch unknown");
});
