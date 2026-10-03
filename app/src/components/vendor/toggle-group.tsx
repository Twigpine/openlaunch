"use client";

// Adapted from coss ui: https://coss.com/ui/r/toggle-group.json and /toggle.json.
// MIT-licensed apps/ui registry source; licensing details: ./LICENSES.md.
// LOCAL PATCH (openlaunch): open, individually selected controls, no outer tray.
// Keep Base UI's roving focus / pressed semantics, replace Coss theme tokens,
// shadows, variants and separators with our flat, two-theme control recipe.
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { cn } from "@/lib/utils";

export function ToggleGroup({ className, ...props }: ToggleGroupPrimitive.Props) {
  return <ToggleGroupPrimitive data-slot="toggle-group" className={cn("inline-flex max-w-full items-center gap-1", className)} {...props} />;
}

export function ToggleGroupItem({ className, ...props }: TogglePrimitive.Props) {
  return <TogglePrimitive data-slot="toggle" className={cn("ui-pressable inline-flex min-h-9 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-medium whitespace-nowrap text-muted hover:bg-card hover:text-ink data-pressed:bg-line data-pressed:text-ink disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none", className)} {...props} />;
}
