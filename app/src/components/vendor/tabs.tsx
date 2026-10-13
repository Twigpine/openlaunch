"use client";

// Adapted from coss ui: https://coss.com/ui/r/tabs.json
// MIT-licensed apps/ui registry source; licensing details: ./LICENSES.md.
// LOCAL PATCH (openlaunch): one flat underline recipe on existing tokens, no shadows. The underline is Base UI's
// indicator, so it slides to the active tab (still under reduced motion). Base UI owns keyboard/ARIA tab semantics.
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "@/lib/utils";

export function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return <TabsPrimitive.Root className={cn("min-w-0", className)} {...props} />;
}
export function TabsList({ className, children, ...props }: TabsPrimitive.List.Props & { className?: string }) {
  return (
    <TabsPrimitive.List className={cn("relative flex gap-5 overflow-x-auto border-b border-line px-5 bb-scroll", className)} {...props}>
      {children}
      <TabsPrimitive.Indicator className="absolute bottom-0 left-0 h-0.5 w-(--active-tab-width) translate-x-(--active-tab-left) rounded-full bg-ink transition-[translate,width] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none" />
    </TabsPrimitive.List>
  );
}
export function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return <TabsPrimitive.Tab className={cn("flex min-h-12 shrink-0 cursor-pointer items-center gap-2 text-sm font-medium text-muted transition-colors hover:text-ink data-active:text-ink motion-reduce:transition-none", className)} {...props} />;
}
export function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return <TabsPrimitive.Panel className={cn("min-w-0", className)} {...props} />;
}
