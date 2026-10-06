"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/vendor/tabs";

/** Server-rendered facts stay on the server; only panel selection is client-side. */
export default function TokenDetails({ trades, holders, conversation, about }: { trades: ReactNode; holders: ReactNode; conversation: ReactNode; about: ReactNode }) {
  const [tab, setTab] = useState("trades");
  useEffect(() => {
    let frame = 0;
    const selectHash = () => { const match: Record<string, string> = { "#comments": "conversation", "#holders": "holders", "#contracts": "about", "#trades": "trades" }; const next = match[window.location.hash]; if (next) { setTab(next); cancelAnimationFrame(frame); frame = requestAnimationFrame(() => document.getElementById("token-details")?.scrollIntoView({ block: "start" })); } };
    const timer = setTimeout(selectHash, 0);
    window.addEventListener("hashchange", selectHash);
    return () => { clearTimeout(timer); cancelAnimationFrame(frame); window.removeEventListener("hashchange", selectHash); };
  }, []);
  return (
    <Tabs id="token-details" value={tab} onValueChange={(v) => setTab(String(v))} className="scroll-mt-24 overflow-hidden rounded-2xl border border-line bg-card">
      <TabsList aria-label="Token details">
        <TabsTab value="trades">Trades</TabsTab>
        <TabsTab value="holders">Holders</TabsTab>
        <TabsTab value="conversation">Conversation</TabsTab>
        {/* the long label only where it fits beside the others */}
        <TabsTab value="about"><span className="sm:hidden">About</span><span className="hidden sm:inline">About & contracts</span></TabsTab>
      </TabsList>
      <TabsPanel value="trades">{trades}</TabsPanel>
      <TabsPanel value="holders">{holders}</TabsPanel>
      <TabsPanel value="conversation" keepMounted>{conversation}</TabsPanel>
      <TabsPanel value="about">{about}</TabsPanel>
    </Tabs>
  );
}
