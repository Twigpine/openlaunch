"use client";

// Adapted from coss ui: https://coss.com/ui/r/tabs.json
// MIT-licensed apps/ui registry source; licensing details: ./LICENSES.md.
// LOCAL PATCH (openlaunch): one flat underline recipe, existing tokens, no
// shadows. The finite indicator follows Base UI's measured tab positions.
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "@/lib/utils";

export function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return <TabsPrimitive.Root className={cn("min-w-0", className)} {...props} />;
}
export function TabsList({ className, children, ...props }: TabsPrimitive.List.Props) {
  return <TabsPrimitive.List className={cn("relative flex gap-5 overflow-x-auto border-b border-line px-5 bb-scroll", className)} {...props}>{children}<TabsPrimitive.Indicator className="ui-tab-indicator motion-reduce:transition-none" /></TabsPrimitive.List>;
}
export function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return <TabsPrimitive.Tab className={cn("flex min-h-12 shrink-0 cursor-pointer items-center gap-2 border-b-2 border-transparent text-sm font-medium text-muted transition-colors duration-150 hover:text-ink data-active:text-ink motion-reduce:transition-none", className)} {...props} />;
}
export function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return <TabsPrimitive.Panel className={cn("min-w-0", className)} {...props} />;
}
