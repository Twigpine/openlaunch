"use client";

// Adapted from coss ui: https://coss.com/ui/r/toggle-group.json and /toggle.json.
// MIT-licensed apps/ui registry source; licensing details: ./LICENSES.md.
// LOCAL PATCH (openlaunch): segmented recipes only. Keeps Base UI's roving focus and pressed semantics,
// replaces Coss theme tokens, variants and separators with our two-theme recipe: a recessed track with a raised thumb
// that slides to the pressed item (a Motion shared layout); the same thumb over a row of chips with no track; or, for
// tab-like rows, a sliding underline.
import { createContext, useContext, useId } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { cn } from "@/lib/utils";

type Variant = "segmented" | "chips" | "underline";
// the shadows read the theme variables at run time (a plain shadow-* utility would bake in the light values)
const TRACK = { segmented: "inline-flex max-w-full items-center gap-0.5 rounded-xl bg-track p-[3px] shadow-(--shadow-track)", chips: "inline-flex max-w-full items-center gap-1", underline: "inline-flex max-w-full items-stretch" };
const Group = createContext<{ id: string; variant: Variant }>({ id: "", variant: "segmented" });

export function ToggleGroup({ className, variant = "segmented", ...props }: ToggleGroupPrimitive.Props & { className?: string; variant?: Variant }) {
  const id = useId();
  return (
    <Group.Provider value={{ id, variant }}>
      <ToggleGroupPrimitive
        data-slot="toggle-group"
        data-variant={variant}
        className={cn(TRACK[variant], className)}
        {...props}
      />
    </Group.Provider>
  );
}

/** `thumbClassName` tints the thumb while this item holds it (the trade panel's green buy and red sell). */
export function ToggleGroupItem({ className, thumbClassName, ...props }: TogglePrimitive.Props & { className?: string; thumbClassName?: string }) {
  const { id, variant } = useContext(Group);
  const reduced = useReducedMotion();
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(
        "relative isolate inline-flex min-h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-[9px] px-3 text-xs font-medium whitespace-nowrap text-muted transition-colors duration-150 select-none hover:text-ink data-pressed:text-ink disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none",
        variant !== "underline" && "hover:bg-ink/[0.04] data-pressed:hover:bg-transparent",
        className,
      )}
      render={(renderProps, state) => (
        <button {...renderProps}>
          {state.pressed ? (
            <motion.span
              aria-hidden="true"
              layoutId={id}
              transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 40, mass: 0.7 }}
              className={cn(variant === "underline" ? "absolute inset-x-1.5 bottom-0 -z-10 h-0.5 rounded-full bg-ink" : "absolute inset-0 -z-10 rounded-[inherit] bg-thumb shadow-(--shadow-thumb)", thumbClassName)}
            />
          ) : null}
          {renderProps.children}
        </button>
      )}
      {...props}
    />
  );
}
