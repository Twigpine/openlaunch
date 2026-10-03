"use client";

import { useState } from "react";
import { Check, ChevronDown, Layers2 } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/vendor/toggle-group";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/vendor/popover";
import { CHAIN_SHORT, type ChainKey } from "@/lib/chainPublic";
import { VISIBLE_CHAINS } from "@/lib/launchpad/config";

/** Compact, keyboard-accessible network selection shared by browsing surfaces. */
export default function ChainSelector({ value, onChange, label = "Chain" }: { value: ChainKey | null; onChange: (chain: ChainKey | null) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger aria-label={`${label}: ${value ? CHAIN_SHORT[value] : "All chains"}`} className="ui-pressable inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3 text-[13px] font-medium text-body hover:bg-card hover:text-ink data-popup-open:bg-card motion-reduce:transition-none">
      <Layers2 size={14} aria-hidden="true" /><span>{value ? CHAIN_SHORT[value] : "All chains"}</span><ChevronDown size={13} aria-hidden="true" className="text-muted" />
    </PopoverTrigger>
    <PopoverContent className="w-56 p-2">
      <PopoverTitle className="px-3 pb-2 pt-2 text-xs font-semibold text-muted">{label}</PopoverTitle>
      <ToggleGroup aria-label={label} orientation="vertical" value={[value ?? "all"]} onValueChange={(values) => { if (!values[0]) return; onChange(values[0] === "all" ? null : values[0] as ChainKey); setOpen(false); }} className="flex w-full flex-col items-stretch gap-1">
        {[null, ...VISIBLE_CHAINS].map((chain) => <ToggleGroupItem key={chain ?? "all"} value={chain ?? "all"} className="min-h-11 w-full justify-between px-3 text-sm">
          {chain ? CHAIN_SHORT[chain] : "All chains"}{chain === value ? <Check size={14} aria-hidden="true" /> : null}
        </ToggleGroupItem>)}
      </ToggleGroup>
    </PopoverContent>
  </Popover>;
}
