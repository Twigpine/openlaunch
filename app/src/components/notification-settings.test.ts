import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { en } from "../i18n/messages/index.ts";

type Element = { type: string; props: Record<string, unknown>; children: unknown[] };
type Tree = { [key: string]: string | Tree };
/** use-intl's useTranslations over the English messages: the text the component renders in English. */
const useTranslations = (namespace: string) => (key: string) =>
  `${namespace}.${key}`.split(".").reduce<string | Tree>((node, part) => (node as Tree)[part], en as unknown as Tree) as string;
const source = readFileSync(new URL("./NotificationSettings.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("NotificationSettings.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "NotificationSettings");
assert.ok(declaration);
const { outputText } = ts.transpileModule(`(${declaration.getText(ast).replace(/^export default /, "")})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } });

function flatten(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (!node || typeof node !== "object" || !("children" in node)) return [];
  return [node as Element, ...(node as Element).children.flatMap(flatten)];
}

// Executes the real component handlers with inert JSX/hooks. Browser checks cover
// Base UI focus management, positioning, touch and keyboard behavior.
function render(enabled: boolean, block = false, saved = true) {
  let chosen: boolean | undefined;
  let open = true;
  const component = runInNewContext(outputText, {
    React: { createElement: (type: string, props: Element["props"], ...children: unknown[]) => ({ type, props: props ?? {}, children }), Fragment: "Fragment" },
    Popover: Object.fromEntries(["Root", "Trigger", "Portal", "Backdrop", "Positioner", "Popup", "Title", "Description", "Close"].map((key) => [key, key])),
    styles: new Proxy({}, { get: (_target, key) => key }),
    Bell: "Bell", Check: "Check", ShieldCheck: "ShieldCheck", X: "X",
    useActivityNotifications: () => enabled,
    setActivityNotifications: (value: boolean) => { chosen = value; },
    activityPreferenceSaved: () => saved,
    useState: () => [open, (value: boolean) => { open = value; }],
    useRef: () => ({ current: null }), useId: () => "notifications",
    useTranslations,
  });
  return { nodes: flatten(component({ block })), saved: () => chosen, open: () => open };
}

test("notification preference is one labelled switch wired to the persistent store", () => {
  for (const enabled of [false, true]) {
    const h = render(enabled);
    const switches = h.nodes.filter((node) => node.props.role === "switch");
    assert.equal(switches.length, 1, "Own transaction messages must not have a mute switch");
    const control = switches[0];
    assert.equal(control.type, "button");
    assert.equal(control.props.type, "button");
    assert.equal(control.props["aria-checked"], enabled);
    assert.ok(h.nodes.some((node) => node.props.id === control.props["aria-labelledby"]));
    assert.ok(h.nodes.some((node) => node.props.id === control.props["aria-describedby"]));
    (control.props.onClick as () => void)();
    assert.equal(h.saved(), !enabled);
  }
});

test("mobile disclosure is portalled and Escape closes only the notification panel", () => {
  const h = render(false, true);
  assert.equal(h.nodes.find((node) => node.type === "Root")?.props.modal, true);
  assert.ok(h.nodes.some((node) => node.type === "Portal"));
  assert.ok(h.nodes.some((node) => node.type === "Backdrop"));
  const popup = h.nodes.find((node) => node.type === "Popup")!;
  let prevented = false;
  let stopped = false;
  (popup.props.onKeyDown as (event: unknown) => void)({ key: "Escape", preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
  assert.equal(h.open(), false);
  assert.equal(prevented && stopped, true);
});

test("notification controls are available on desktop/mobile with reduced-motion and focus styles", () => {
  const header = readFileSync(new URL("./HeaderNav.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("./NotificationSettings.module.css", import.meta.url), "utf8");
  assert.match(header, /<NotificationSettings \/>/);
  assert.match(header, /<NotificationSettings block \/>/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /calc\(100vw - 24px\)/);
  assert.match(source, /t\("yours"\)/);
  assert.match(source, /t\("alwaysOn"\)/);
  assert.equal(en.header.notifications.yours, "Your transactions");
  assert.equal(en.header.notifications.alwaysOn, "Always on");
  assert.doesNotMatch(source, /fetch\(|signMessage|sendTransaction|Notification.requestPermission/);
});

test("the settings footer only promises persistence when this browser actually stores it", () => {
  const text = (nodes: Element[]) => nodes.filter((node) => node.props.className === "footer").flatMap((node) => node.children).join("");
  assert.match(text(render(true, false, true).nodes), /^Saved in this browser\. The activity feed stays live\.$/);
  const blocked = text(render(true, false, false).nodes);
  assert.doesNotMatch(blocked, /Saved in this browser/);
  assert.match(blocked, /blocking saved settings, so this choice lasts until you leave the page/);
});
