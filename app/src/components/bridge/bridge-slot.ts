import type { BridgeLink } from "@/lib/bridge/link";

/**
 * Where the full-page bridge goes. The bridge has one controller (BridgeProvider, in the root layout) so a transfer is
 * tracked once however many places show it. The /bridge page does not start a second one: it registers an empty
 * element here and the controller renders the panel into it. A tiny module-level store, so a page can hand its
 * element up to a controller mounted above it.
 */
export type BridgeSlot = { node: HTMLElement | null; link: BridgeLink | null };
const EMPTY: BridgeSlot = { node: null, link: null };
let current: BridgeSlot = EMPTY;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

export const bridgeSlot = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot: () => current,
  getServerSnapshot: () => EMPTY,
  /** Registers the page's element; the returned function withdraws it (only if it is still the registered one). */
  mount(node: HTMLElement, link: BridgeLink | null) {
    current = { node, link };
    emit();
    return () => { if (current.node === node) { current = EMPTY; emit(); } };
  },
};
