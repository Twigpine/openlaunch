"use client";

import { useSyncExternalStore } from "react";
import { createWatchlistStore, WATCHLIST_SERVER_SNAPSHOT, WATCHLIST_STORAGE_KEY } from "@/lib/launchpad/watchlist";

const store = createWatchlistStore({
  read: () => window.localStorage.getItem(WATCHLIST_STORAGE_KEY),
  write: (value) => window.localStorage.setItem(WATCHLIST_STORAGE_KEY, value),
});
let subscribers = 0;

function onStorage(event: StorageEvent) {
  if (event.key === WATCHLIST_STORAGE_KEY || event.key === null) store.refresh();
}

function subscribe(listener: () => void) {
  const unsubscribe = store.subscribe(listener);
  if (subscribers++ === 0) {
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", store.refresh);
    store.refresh();
  }
  return () => {
    unsubscribe();
    if (--subscribers === 0) {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", store.refresh);
    }
  };
}

const getServerSnapshot = () => WATCHLIST_SERVER_SNAPSHOT;

/** One shared store synchronizes every star and view, with a stable server/hydration snapshot. */
export function useWatchlist() {
  const snapshot = useSyncExternalStore(subscribe, store.getSnapshot, getServerSnapshot);
  return { ...snapshot, toggle: store.toggle, markSeen: store.markSeen };
}
