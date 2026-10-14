import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createTranslator } from "use-intl/core";
import type { FeedItem } from "@/lib/launchpad/queries";
import * as queueFunctions from "@/lib/launchpad/toast-queue";
import { fmtQuote } from "@/lib/launchpad/math";
import { en } from "../../i18n/messages/index.ts";

/** use-intl's useTranslations over the English messages: the words an English reader gets. */
const useTranslations = (namespace: "activity.toasts") => createTranslator({ locale: "en", messages: en, namespace, timeZone: "UTC" });

type Element = { type: unknown; props: Record<string, unknown>; children: unknown[] };
const jsx = { createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({ type, props: props ?? {}, children }), Fragment: "fragment" };
const source = ts.createSourceFile("TxToasts.tsx", readFileSync(new URL("./TxToasts.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** Execute the actual functions with inert hooks/JSX, as transaction-safety.test does for handlers.
 * Browser QA remains responsible for React lifecycle and real focus/pointer behavior. */
function component(name: string, bindings: Record<string, unknown>) {
  const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration);
  const code = `(${declaration.getText(source).replace(/^export default /, "")})`;
  const { outputText } = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } });
  return runInNewContext(outputText, { React: jsx, ...bindings });
}

function elements(node: unknown): Element[] {
  if (!node || typeof node !== "object" || !("children" in node)) return [];
  const element = node as Element;
  return [element, ...element.children.flatMap(elements)];
}

function harness(initial: FeedItem[] = [], enabled = false, initialAt?: number, overrides: Record<string, unknown> = {}) {
  let state = queueFunctions.createToastQueue();
  let now = 0;
  let hook = 0;
  let effects: { setup: () => (() => void) | void; deps: unknown[] }[] = [];
  let mounted: { cleanup: (() => void) | void; deps: unknown[] }[] = [];
  const events = new Set<(event: unknown) => void>();
  const subscribers = new Set<(snapshot: { feed: FeedItem[]; at?: number }) => void>();
  const preferences = new Set<() => void>();
  let activityEnabled = enabled;
  const timers = new Map<number, { fn: () => void; delay: number }>();
  let timerId = 0;
  const fresh = queueFunctions.createToastFeedTracker(initial, initialAt);
  const subscribe = (fn: (snapshot: { feed: FeedItem[]; at?: number }) => void) => { subscribers.add(fn); return () => subscribers.delete(fn); };
  let push: unknown;
  const renderComponent = component("TxToasts", {
    ...queueFunctions,
    getActivityNotifications: () => activityEnabled,
    subscribeActivityNotifications: (fn: () => void) => { preferences.add(fn); return () => preferences.delete(fn); },
    Date: { now: () => now },
    useLive: () => ({ live: { feed: initial }, subscribe }),
    useState: () => ++hook === 1 ? [state, (update: (current: queueFunctions.ToastQueue) => queueFunctions.ToastQueue) => { state = update(state); }] : [fresh],
    useCallback: (fn: unknown) => push ??= fn,
    useEffect: (setup: () => (() => void) | void, deps: unknown[]) => effects.push({ setup, deps }),
    // an Effect Event is the latest render's function; the words here never change, so the function itself stands in
    useEffectEvent: (fn: unknown) => fn,
    useTranslations,
    window: { addEventListener: (_name: string, fn: (event: unknown) => void) => events.add(fn), removeEventListener: (_name: string, fn: (event: unknown) => void) => events.delete(fn) },
    setTimeout: (fn: () => void, delay: number) => { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
    ToastCard: "ToastCard", Confetti: "Confetti", CHAIN_SHORT: { base: "Base" }, shortAddr: () => "wallet", fmtQuote: () => "1 ETH",
    ...overrides,
  });
  function render() {
    hook = 0;
    effects = [];
    const tree = renderComponent();
    mounted = effects.map(({ setup, deps }, index) => {
      const previous = mounted[index];
      if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return previous;
      previous?.cleanup?.();
      return { cleanup: setup(), deps };
    });
    return elements(tree);
  }
  return {
    render,
    state: () => state,
    now: (value: number) => { now = value; },
    local: (detail: queueFunctions.ToastDetail) => events.forEach((fn) => fn({ detail })),
    feed: (feed: FeedItem[], at?: number) => subscribers.forEach((fn) => fn({ feed, at })),
    setActivity: (enabled: boolean) => { activityEnabled = enabled; preferences.forEach((fn) => fn()); },
    timers, events, subscribers, preferences,
    unmount: () => mounted.forEach(({ cleanup }) => cleanup?.()),
  };
}

const swap = (id: string, quote_wei: string, quote_decimals: number, quote_symbol: string, is_buy = true): FeedItem => ({ kind: "swap", chain: "base", at: "2026-09-01T00:00:00Z", tx_hash: id, log_index: 7, token: "dusty", name: "Dusty", symbol: "DUSTY", trader: "0xabc", is_buy, is_dev: false, quote_wei, quote_key: quote_decimals === 6 ? "usdg" : "eth", quote_symbol, quote_decimals, usd: null, image_url: null });
const launch = (id: string): FeedItem => ({ kind: "launch", chain: "base", at: "2026-09-01T00:00:00Z", tx_hash: id, token: id, name: id, symbol: id, launcher: "wallet", lp_fee: 0, quote_key: "eth", image_url: null });
const invoke = (element: Element, handler: string, ...args: unknown[]) => (element.props[handler] as (...args: unknown[]) => void)(...args);
const cardBindings = { Link: "Link", TokenAvatar: "TokenAvatar", ArrowDownLeft: "ArrowDownLeft", ArrowUpRight: "ArrowUpRight", Check: "Check", Coins: "Coins", Info: "Info", Plus: "Plus", X: "X", CHAIN_SHORT: { base: "Base", robinhood: "Robinhood" }, TOAST_TTL_MS: queueFunctions.TOAST_TTL_MS, useTranslations };

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object" || !("children" in node)) return "";
  return (node as Element).children.map(textOf).join(" ");
}

test("actual local/feed handlers render one card, preserve history, and celebrate only the active confirmation", () => {
  const history = launch("history");
  const h = harness([history]);
  h.render();
  h.setActivity(true);
  h.feed([history]);
  assert.equal(h.state().active, null);
  h.feed([launch("second"), launch("first"), history]);
  h.local({ kind: "buy", title: "Your buy", celebrate: true });
  let output = h.render();
  assert.equal(output.filter((node) => node.type === "ToastCard").length, 1);
  assert.equal(output.filter((node) => node.type === "Confetti").length, 0);
  assert.equal(h.state().active?.title, "first just launched on Base");
  invoke(output.find((node) => node.type === "ToastCard")!, "onClose");
  output = h.render();
  assert.equal(h.state().active?.title, "Your buy");
  assert.equal(output.filter((node) => node.type === "ToastCard").length, 1);
  assert.equal(output.filter((node) => node.type === "Confetti").length, 1);
  h.feed([launch("second"), launch("first"), history]);
  assert.equal(h.state().pending.length, 1);
  h.unmount();
  assert.equal(h.events.size, 0);
  assert.equal(h.subscribers.size, 0);
  assert.equal(h.preferences.size, 0);
  assert.equal(h.timers.size, 0);
});

test("muted feed stays observed without replay, while own confirmations and notices always show", () => {
  const h = harness();
  h.render();
  h.feed([launch("muted")]);
  assert.equal(h.state().active, null);
  h.local({ kind: "info", title: "Your wallet needs attention" });
  assert.equal(h.state().active?.title, "Your wallet needs attention");
  h.setActivity(true);
  h.feed([launch("muted")]);
  assert.equal(h.state().pending.length, 0);
  h.feed([launch("fresh"), launch("muted")]);
  assert.equal(h.state().pending.length, 1);
  h.setActivity(false);
  assert.equal(h.state().active?.title, "Your wallet needs attention");
  assert.equal(h.state().pending.length, 0);
  h.local({ kind: "buy", title: "Your buy confirmed" });
  assert.equal(h.state().pending[0].title, "Your buy confirmed");
  h.setActivity(true);
  h.feed([launch("fresh"), launch("muted")]);
  assert.equal(h.state().pending.length, 1, "neither ignored nor discarded activity is replayed");
  h.unmount();
});

test("activity enabled on mount (the default) accepts fresh activity without replaying the initial snapshot", () => {
  const history = launch("history");
  const h = harness([history], true);
  h.render();
  h.feed([history]);
  assert.equal(h.state().active, null);
  h.feed([launch("new"), history]);
  assert.equal(h.state().active?.title, "new just launched on Base");
  h.unmount();
});

test("a preference change immediately removes ambient cards and keeps the next local confirmation", () => {
  const h = harness();
  h.render();
  h.setActivity(true);
  h.feed([]);
  h.feed([launch("ambient")]);
  h.local({ kind: "buy", title: "Your buy", celebrate: true });
  h.render();
  const staleTimer = [...h.timers.values()][0];
  h.now(1_000);
  h.setActivity(false);
  assert.equal(h.state().active?.title, "Your buy");
  assert.equal(h.state().active?.startedAt, 1_000);
  assert.equal(h.state().pending.length, 0);
  h.now(6_000);
  staleTimer.fn();
  assert.equal(h.state().active?.title, "Your buy", "an old activity timer cannot dismiss the promoted local event");
  h.unmount();
});

test("re-enabling after no muted snapshots establishes a silent baseline, including across rerenders", () => {
  const history = launch("history");
  const h = harness([history], true);
  h.render();
  h.setActivity(false);
  // The tab is hidden or offline here: no successful feed snapshots arrive while muted.
  h.now(60_000);
  h.setActivity(true);
  h.local({ kind: "info", title: "Your wallet needs attention" });
  h.render();
  h.feed([launch("during muted gap"), history]);
  assert.equal(h.state().active?.title, "Your wallet needs attention");
  assert.equal(h.state().pending.length, 0, "unseen activity from the muted gap is baseline history");
  h.render();
  h.feed([launch("after baseline"), launch("during muted gap"), history]);
  assert.equal(h.state().pending.length, 1);
  assert.equal(h.state().pending[0].title, "after baseline just launched on Base");
  h.setActivity(true); // A duplicate preference write must not silence another live poll.
  h.feed([launch("still live"), launch("after baseline"), launch("during muted gap"), history]);
  assert.equal(h.state().pending.length, 2);
  h.unmount();
});

test("actual interaction handlers preserve remaining time and ignore blur between card controls", () => {
  const h = harness();
  h.render();
  h.local({ kind: "info", title: "Read this" });
  let region = h.render().find((node) => node.props["aria-live"] === "polite")!;
  assert.equal([...h.timers.values()][0].delay, 6_000);
  h.now(2_000);
  invoke(region, "onMouseEnter");
  invoke(region, "onFocus");
  region = h.render().find((node) => node.props["aria-live"] === "polite")!;
  assert.equal(h.timers.size, 0);
  invoke(region, "onMouseLeave");
  invoke(region, "onBlur", { currentTarget: { contains: () => true }, relatedTarget: {} });
  assert.equal(h.state().focus, true);
  h.now(20_000);
  invoke(region, "onBlur", { currentTarget: { contains: () => false }, relatedTarget: null });
  h.render();
  assert.equal([...h.timers.values()][0].delay, 4_000);
  h.now(24_000);
  [...h.timers.values()][0].fn();
  h.render();
  assert.equal(h.state().active?.leaving, true);
  assert.equal([...h.timers.values()][0].delay, queueFunctions.TOAST_EXIT_MS);
  h.unmount();
  assert.equal(h.timers.size, 0);
});

test("the actual card keeps dismissal outside its link and entrance visible while its clock is paused", () => {
  const card = component("ToastCard", cardBindings);
  let dismissed = 0;
  const active = queueFunctions.enqueueToast(queueFunctions.createToastQueue(), { id: "one", source: "local", kind: "buy", title: "Confirmed", chain: "base", token: "token", symbol: "TEST" }, 0).active!;
  const output = card({ t: { ...active, startedAt: null }, onClose: () => dismissed++ }) as Element;
  const link = output.children.find((node) => (node as Element)?.type === "Link") as Element;
  const button = output.children.find((node) => (node as Element)?.type === "button") as Element;
  assert.ok(link && button, "navigation and dismissal are sibling controls");
  assert.equal(elements(link).filter((node) => node.type === "button").length, 0);
  assert.equal(link.props.href, "/t/base/token");
  invoke(button, "onClick");
  assert.equal(dismissed, 1);
  assert.equal((output.props.style as { animationPlayState: string }).animationPlayState, "running");
  const leaving = card({ t: { ...active, startedAt: null, leaving: true }, onClose: () => {} }) as Element;
  assert.equal((leaving.props.style as { animationPlayState: string }).animationPlayState, "paused");
});

test("card distinguishes confirmed transactions from notices and chain activity without inventing context", () => {
  const card = component("ToastCard", cardBindings);
  for (const [kind, source, label] of [["buy", "local", "Confirmed"], ["collect", "local", "Confirmed"], ["info", "local", "Update"], ["buy", "activity", "Live activity"]] as const) {
    const active = queueFunctions.enqueueToast(queueFunctions.createToastQueue(), { id: kind, kind, source, title: "Original title", sub: "Original details" }, 0).active!;
    const output = card({ t: active, onClose: () => {} });
    assert.ok(textOf(output).includes(label));
    assert.ok(textOf(output).includes("Original title"));
    assert.ok(textOf(output).includes("Original details"));
    assert.equal(elements(output).some((node) => node.type === "Link"), false, "No token means no invented link");
    assert.equal(textOf(output).includes("Base"), false, "No chain means no invented network");
    assert.equal(textOf(output).includes("View token"), false);
  }
});

test("queue count stays out of live announcements and lifetime track follows pause without refilling on exit", () => {
  const card = component("ToastCard", cardBindings);
  const active = queueFunctions.enqueueToast(queueFunctions.createToastQueue(), { id: "one", kind: "buy", source: "local", title: "Bought", chain: "base", token: "token" }, 0).active!;
  const output = card({ t: { ...active, startedAt: null }, pending: 12, onClose: () => {} });
  const nodes = elements(output);
  const queued = nodes.find((node) => node.props.className === "bb-toast-queued")!;
  assert.equal(textOf(queued), "12 queued");
  assert.equal(queued.props["aria-live"], "off");
  const progress = nodes.find((node) => node.props.className === "bb-toast-progress")!;
  assert.equal((progress.props.style as Record<string, unknown>).animationPlayState, "paused");
  assert.equal((progress.props.style as Record<string, unknown>).animationDuration, "6000ms");
  const exit = elements(card({ t: { ...active, leaving: true, remainingMs: 350 }, onClose: () => {} })).find((node) => node.props.className === "bb-toast-progress")!;
  assert.equal((exit.props.style as Record<string, unknown>).opacity, 0);
  assert.equal((exit.props.style as Record<string, unknown>).animationDuration, "6000ms");
});

test("returning to a tab after a gap does not queue the activity missed while it was hidden", () => {
  const history = launch("history");
  const h = harness([history], true, 100_000);
  h.render();
  h.feed([history], 105_000);
  const missed = Array.from({ length: 24 }, (_, i) => launch(`missed-${i}`));
  h.feed([...missed, history], 105_000 + 10 * 60_000);
  assert.equal(h.state().active, null, "no stale 'just launched' card");
  assert.equal(h.state().pending.length, 0);
  h.feed([launch("live"), ...missed], 105_000 + 10 * 60_000 + 5_000);
  assert.equal(h.state().active?.title, "live just launched on Base");
  h.unmount();
});

test("a timer that fires early re-arms for the remainder instead of freezing the queue", () => {
  const h = harness();
  h.render();
  h.local({ kind: "buy", title: "Your buy" });
  h.local({ kind: "sell", title: "Your sell" });
  h.render();
  assert.equal(h.timers.size, 1);
  const [[firstId, first]] = [...h.timers.entries()];
  assert.equal(first.delay, queueFunctions.TOAST_TTL_MS);
  h.timers.delete(firstId);
  h.now(queueFunctions.TOAST_TTL_MS - 1); // fires 1ms early by Date.now()
  first.fn();
  assert.equal(h.state().active?.title, "Your buy");
  assert.equal(h.state().active?.leaving, false);
  assert.equal(h.timers.size, 1, "a follow-up timer is armed, so the card cannot stick");
  const [[secondId, second]] = [...h.timers.entries()];
  assert.equal(second.delay, 1);
  h.timers.delete(secondId);
  h.now(queueFunctions.TOAST_TTL_MS);
  second.fn();
  assert.equal(h.state().active?.leaving, true, "the card starts leaving on time");
  h.render();
  const [[exitId, exit]] = [...h.timers.entries()];
  h.timers.delete(exitId);
  h.now(queueFunctions.TOAST_TTL_MS + queueFunctions.TOAST_EXIT_MS);
  exit.fn();
  assert.equal(h.state().active?.title, "Your sell", "and the queue moves on");
  h.unmount();
});

test("a swap under the display floor never toasts as a bare 0: the real formatter says \"<0.01\" / \"<0.00000001\"", () => {
  const history = launch("history");
  const h = harness([history], true, undefined, { fmtQuote });
  h.render();
  h.feed([history]);
  // 4,999 raw USDG (under half a cent) used to read "Buy 0 USDG of DUSTY"
  h.feed([swap("dust-usdg", "4999", 6, "USDG"), history]);
  assert.equal(h.state().active?.title, "Buy <0.01 USDG of DUSTY");
  h.feed([swap("dust-eth", "4999999999", 18, "ETH", false), swap("dust-usdg", "4999", 6, "USDG"), history]);
  assert.equal(h.state().pending[0]?.title, "Sell <0.00000001 ETH of DUSTY");
  // the first amount that shows a digit still shows it
  h.feed([swap("cent", "5000", 6, "USDG"), swap("dust-eth", "4999999999", 18, "ETH", false), swap("dust-usdg", "4999", 6, "USDG"), history]);
  assert.equal(h.state().pending[1]?.title, "Buy 0.01 USDG of DUSTY");
  for (const card of [h.state().active, ...h.state().pending]) assert.doesNotMatch(card?.title ?? "", /\b0 (USDG|ETH)\b/, "no card reads as a zero-amount trade");
  h.unmount();
});
