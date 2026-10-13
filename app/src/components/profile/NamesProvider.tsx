"use client";

import { createContext, useEffect, useMemo, useContext } from "react";
import { seedNames, type NameEntry } from "@/lib/profiles/names-client";

export const NamesContext = createContext<Record<string, NameEntry | null> | null>(null);

/**
 * Names a server page already looked up, so the first paint (server HTML and hydration alike) shows them.
 * Nested providers merge; the entries are also copied into the browser store for components outside the tree.
 */
export default function NamesProvider({ names, children }: { names: Record<string, NameEntry | null>; children: React.ReactNode }) {
  const parent = useContext(NamesContext);
  const merged = useMemo(() => ({ ...(parent ?? {}), ...names }), [parent, names]);
  useEffect(() => seedNames(names), [names]);
  return <NamesContext.Provider value={merged}>{children}</NamesContext.Provider>;
}
