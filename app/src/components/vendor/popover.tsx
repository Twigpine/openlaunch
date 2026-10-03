"use client";

// Original Openlaunch recipe using the installed Base UI primitive. Same
// composition as Coss, with our tokens; no registry theme or extra dependency.
import { Popover as Primitive } from "@base-ui/react/popover";
import { cn } from "@/lib/utils";

export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;
export const PopoverTitle = Primitive.Title;
export const PopoverDescription = Primitive.Description;
export const PopoverClose = Primitive.Close;

export function PopoverContent({ className, align = "end", ...props }: Primitive.Popup.Props & { align?: Primitive.Positioner.Props["align"] }) {
  return <Primitive.Portal>
    <Primitive.Positioner sideOffset={8} align={align} collisionPadding={12} className="z-[90]">
      <Primitive.Popup className={cn("max-h-[var(--available-height)] w-72 max-w-[calc(100vw-24px)] origin-[var(--transform-origin)] overflow-y-auto rounded-xl border border-line-strong bg-card p-3 text-ink transition-[opacity,transform] duration-(--ui-panel-duration) ease-(--ui-ease-out) data-starting-style:translate-y-1 data-starting-style:opacity-0 data-ending-style:translate-y-1 data-ending-style:opacity-0 motion-reduce:transition-none", className)} {...props} />
    </Primitive.Positioner>
  </Primitive.Portal>;
}
